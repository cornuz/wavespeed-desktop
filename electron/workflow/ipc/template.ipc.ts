import { ipcMain } from "electron";
import * as templateRepo from "../db/template.repo";
import { migrateTemplatesSync } from "../services/template-migration";
import {
  getFileTemplates,
  getFileTemplateById,
} from "../services/template-init";
import type {
  Template,
  TemplateFilter,
  CreateTemplateInput,
  TemplateExport,
} from "../../../src/types/template";

export function registerTemplateIpc(): void {
  ipcMain.handle(
    "template:migrate",
    async (
      _event,
      args: { legacyTemplatesJson: string; migrationComplete: boolean },
    ) => {
      return migrateTemplatesSync(
        args.legacyTemplatesJson,
        args.migrationComplete,
      );
    },
  );

  ipcMain.handle(
    "template:create",
    async (_event, input: CreateTemplateInput): Promise<Template> => {
      validateCreateInput(input);
      return templateRepo.createTemplate(input);
    },
  );

  ipcMain.handle(
    "template:get",
    async (_event, args: { id: string }): Promise<Template | null> => {
      // Check file templates first, then database
      return (
        getFileTemplateById(args.id) || templateRepo.getTemplateById(args.id)
      );
    },
  );

  ipcMain.handle(
    "template:query",
    async (_event, filter?: TemplateFilter): Promise<Template[]> => {
      const dbTemplates = templateRepo.queryTemplates(filter);
      const fileTemps = getFileTemplates(filter);
      // Deduplicate: file templates take priority over DB templates with the same name
      const fileNames = new Set(fileTemps.map((t) => t.name));
      const dedupedDb = dbTemplates.filter((t) => !fileNames.has(t.name));
      // Sort: file (public) first, then DB public, then custom last
      const dbPublic = dedupedDb.filter((t) => t.type === "public");
      const dbCustom = dedupedDb.filter((t) => t.type !== "public");
      return [...fileTemps, ...dbPublic, ...dbCustom];
    },
  );

  ipcMain.handle(
    "template:update",
    async (
      _event,
      args: { id: string; updates: Partial<Template> },
    ): Promise<void> => {
      return templateRepo.updateTemplate(args.id, args.updates);
    },
  );

  ipcMain.handle(
    "template:toggleFavorite",
    async (_event, args: { id: string }): Promise<boolean> => {
      return templateRepo.toggleFavorite(args.id);
    },
  );

  ipcMain.handle(
    "template:incrementUseCount",
    async (_event, args: { id: string }): Promise<void> => {
      return templateRepo.incrementUseCount(args.id);
    },
  );

  ipcMain.handle(
    "template:delete",
    async (_event, args: { id: string }): Promise<void> => {
      if (args.id.startsWith("file-")) return; // file templates cannot be deleted
      return templateRepo.deleteTemplate(args.id);
    },
  );

  ipcMain.handle(
    "template:deleteMany",
    async (_event, args: { ids: string[] }): Promise<void> => {
      const deletable = args.ids.filter((id) => !id.startsWith("file-"));
      if (deletable.length === 0) return;
      return templateRepo.deleteTemplates(deletable);
    },
  );

  ipcMain.handle(
    "template:queryNames",
    async (_event, args?: { templateType?: string }): Promise<string[]> => {
      const dbNames = templateRepo.queryTemplateNames(args?.templateType);
      const fileTemps = getFileTemplates(
        args?.templateType
          ? { templateType: args.templateType as "playground" | "workflow" }
          : undefined,
      );
      const fileNames = fileTemps.map((t) => t.name);
      return [...new Set([...fileNames, ...dbNames])];
    },
  );

  ipcMain.handle(
    "template:export",
    async (_event, args: { ids?: string[] }): Promise<TemplateExport> => {
      let templates: Template[];
      if (args.ids) {
        templates = args.ids
          .map((id) =>
            id.startsWith("file-")
              ? getFileTemplateById(id)
              : templateRepo.getTemplateById(id),
          )
          .filter(Boolean) as Template[];
      } else {
        templates = templateRepo.queryTemplates();
      }

      return {
        version: "1.0",
        exportedAt: new Date().toISOString(),
        templates,
      };
    },
  );

  ipcMain.handle(
    "template:import",
    async (
      _event,
      args: { data: TemplateExport; mode: "merge" | "replace" | "rename" },
    ): Promise<{ imported: number; skipped: number; replaced: number }> => {
      validateImportData(args.data);

      let replaced = 0;

      if (args.mode === "replace") {
        // Replace: delete existing custom templates that have the same name+type as imports
        const importedTypes = new Set(
          args.data.templates.map((t) => t.templateType),
        );
        for (const tplType of importedTypes) {
          const existing = templateRepo.queryTemplates({
            templateType: tplType as "playground" | "workflow",
            type: "custom",
          });
          const importNames = new Set(
            args.data.templates
              .filter((t) => t.templateType === tplType)
              .map((t) => t.name),
          );
          const toDelete = existing.filter((t) => importNames.has(t.name));
          if (toDelete.length > 0) {
            templateRepo.deleteTemplates(toDelete.map((t) => t.id));
            replaced += toDelete.length;
          }
        }
      }

      let imported = 0;
      let skipped = 0;

      // Build a live set of existing names (per templateType) for dedup / rename
      const existingNamesByType: Record<string, Set<string>> = {};
      for (const t of templateRepo.queryTemplates()) {
        if (!existingNamesByType[t.templateType])
          existingNamesByType[t.templateType] = new Set();
        existingNamesByType[t.templateType].add(t.name);
      }
      // Also include file template names
      for (const t of getFileTemplates()) {
        if (!existingNamesByType[t.templateType])
          existingNamesByType[t.templateType] = new Set();
        existingNamesByType[t.templateType].add(t.name);
      }

      for (const template of args.data.templates) {
        const typeNames =
          existingNamesByType[template.templateType] ?? new Set();
        let finalName = template.name;

        if (typeNames.has(template.name)) {
          if (args.mode === "merge") {
            skipped++;
            continue;
          }
          if (args.mode === "rename") {
            // Auto-rename: append (2), (3), etc.
            let counter = 2;
            while (typeNames.has(`${template.name} (${counter})`)) counter++;
            finalName = `${template.name} (${counter})`;
          }
          // For "replace" mode, conflicting ones were already deleted above, so name is free
        }

        templateRepo.createTemplate({
          name: finalName,
          description: template.description,
          tags: template.tags,
          type: "custom",
          templateType: template.templateType,
          author: template.author,
          thumbnail: template.thumbnail,
          playgroundData: template.playgroundData,
          workflowData: template.workflowData,
        });
        typeNames.add(finalName);
        imported++;
      }

      return { imported, skipped, replaced };
    },
  );
}

function validateCreateInput(input: CreateTemplateInput): void {
  if (!input.name || input.name.trim() === "") {
    throw new Error("Template name is required");
  }

  if (!["playground", "workflow"].includes(input.templateType)) {
    throw new Error("Invalid templateType");
  }

  if (!["public", "custom"].includes(input.type)) {
    throw new Error("Invalid type");
  }

  if (input.templateType === "playground" && !input.playgroundData) {
    throw new Error("playgroundData is required for playground templates");
  }

  if (input.templateType === "workflow" && !input.workflowData) {
    throw new Error("workflowData is required for workflow templates");
  }

  if (input.tags && !Array.isArray(input.tags)) {
    throw new Error("tags must be an array");
  }
}

function validateImportData(data: TemplateExport): void {
  if (!data.templates || !Array.isArray(data.templates)) {
    throw new Error("Invalid import data: missing templates array");
  }

  if (!data.version) {
    throw new Error("Invalid import data: missing version");
  }
}
