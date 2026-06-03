import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "@/lib/utils";

function setGlobalSliderCursor(isDragging: boolean): void {
  if (typeof document === "undefined") {
    return;
  }

  document.body.style.cursor = isDragging ? "grabbing" : "";
}

function getDecimalPlaces(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const [, fractional = ""] = value.toString().split(".");
  return fractional.length;
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function snapValue(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) {
    return clampValue(value, min, max);
  }

  const precision = getDecimalPlaces(step);
  const snapped = min + Math.round((value - min) / step) * step;
  return clampValue(Number(snapped.toFixed(precision)), min, max);
}

function getSingleValue(
  values: number[] | undefined,
  min: number,
  max: number,
  step: number,
  fallback: number,
): number {
  const candidate = Array.isArray(values) && typeof values[0] === "number" ? values[0] : fallback;
  return snapValue(candidate, min, max, step);
}

type SliderProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
  centeredFill?: boolean;
  gradientFill?: boolean;
};

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  SliderProps
>(
  (
    {
      className,
      value,
      defaultValue,
      min = 0,
      max = 100,
      step = 1,
      disabled = false,
      orientation = "horizontal",
      dir,
      inverted = false,
      centeredFill = false,
      gradientFill = false,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onValueChange,
      onValueCommit,
      ...props
    },
    ref,
  ) => {
    const thumbCount = Array.isArray(value)
      ? value.length
      : Array.isArray(defaultValue)
        ? defaultValue.length
        : 1;
    const isControlled = value !== undefined;
    const safeStep = step > 0 ? step : 1;
    const initialValue = getSingleValue(defaultValue, min, max, safeStep, min);
    const canUseCustomPointerDrag = thumbCount === 1 && orientation === "horizontal";
    const hasCenteredFill = centeredFill && min < 0 && max > 0;

    const [uncontrolledValue, setUncontrolledValue] = React.useState(initialValue);
    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const trackRef = React.useRef<HTMLDivElement | null>(null);
    const rangeRef = React.useRef<HTMLDivElement | null>(null);
    const thumbRef = React.useRef<HTMLDivElement | null>(null);
    const dragPointerIdRef = React.useRef<number | null>(null);
    const dragValueRef = React.useRef<number | null>(null);
    const isDraggingRef = React.useRef(false);
    const pendingChangeValueRef = React.useRef<number | null>(null);
    const changeTimeoutRef = React.useRef<number | null>(null);

    const committedValue = isControlled
      ? getSingleValue(value, min, max, safeStep, initialValue)
      : uncontrolledValue;
    const displayValue = dragValueRef.current ?? committedValue;

    React.useEffect(() => {
      if (typeof window === "undefined") {
        return;
      }

      const clearCursor = () => setGlobalSliderCursor(false);
      window.addEventListener("pointerup", clearCursor);
      window.addEventListener("pointercancel", clearCursor);
      window.addEventListener("blur", clearCursor);

      return () => {
        window.removeEventListener("pointerup", clearCursor);
        window.removeEventListener("pointercancel", clearCursor);
        window.removeEventListener("blur", clearCursor);
        clearCursor();
      };
    }, []);

    React.useEffect(() => {
      return () => {
        if (changeTimeoutRef.current != null && typeof window !== "undefined") {
          window.clearTimeout(changeTimeoutRef.current);
        }
      };
    }, []);

    const shouldInvert = React.useMemo(() => {
      const isRtl =
        dir === "rtl" || (dir == null && typeof document !== "undefined" && document.dir === "rtl");
      return isRtl ? !inverted : inverted;
    }, [dir, inverted]);

    const getRangeBackground = React.useCallback(
      (rangeStartPercent: number, rangeEndPercent: number) => {
        if (!gradientFill) {
          return "";
        }

        return rangeEndPercent >= rangeStartPercent
          ? "linear-gradient(90deg, hsl(var(--primary) / 0.25) 0%, hsl(var(--primary) / 1) 100%)"
          : "linear-gradient(270deg, hsl(var(--primary) / 0.25) 0%, hsl(var(--primary) / 1) 100%)";
      },
      [gradientFill],
    );

    const applyVisualValue = React.useCallback(
      (nextValue: number) => {
        const percent = max > min ? ((nextValue - min) / (max - min)) * 100 : 0;
        const visualPercent = shouldInvert ? 100 - percent : percent;
        const centerPercentRaw = max > min ? ((0 - min) / (max - min)) * 100 : 0;
        const centerPercent = shouldInvert ? 100 - centerPercentRaw : centerPercentRaw;
        if (rangeRef.current) {
          if (hasCenteredFill) {
            const rangeStart = Math.min(centerPercent, visualPercent);
            const rangeWidth = Math.abs(centerPercent - visualPercent);
            rangeRef.current.style.left = `${rangeStart}%`;
            rangeRef.current.style.right = "";
            rangeRef.current.style.width = `${rangeWidth}%`;
            rangeRef.current.style.background = getRangeBackground(centerPercent, visualPercent);
          } else if (shouldInvert) {
            rangeRef.current.style.left = "";
            rangeRef.current.style.right = "0";
            rangeRef.current.style.width = `${100 - visualPercent}%`;
            rangeRef.current.style.background = getRangeBackground(100, visualPercent);
          } else {
            rangeRef.current.style.left = "0";
            rangeRef.current.style.right = "";
            rangeRef.current.style.width = `${visualPercent}%`;
            rangeRef.current.style.background = getRangeBackground(0, visualPercent);
          }
        }
        if (thumbRef.current) {
          thumbRef.current.style.left = `${visualPercent}%`;
        }
      },
      [getRangeBackground, hasCenteredFill, max, min, shouldInvert],
    );

    React.useEffect(() => {
      if (!isDraggingRef.current) {
        applyVisualValue(committedValue);
      }
    }, [applyVisualValue, committedValue]);

    const flushChange = React.useCallback(() => {
      changeTimeoutRef.current = null;
      const pendingValue = pendingChangeValueRef.current;
      if (pendingValue == null) {
        return;
      }
      pendingChangeValueRef.current = null;
      onValueChange?.([pendingValue]);
    }, [onValueChange]);

    const scheduleChange = React.useCallback(
      (nextValue: number) => {
        pendingChangeValueRef.current = nextValue;
        if (changeTimeoutRef.current != null || typeof window === "undefined") {
          return;
        }
        changeTimeoutRef.current = window.setTimeout(flushChange, 0);
      },
      [flushChange],
    );

    const emitChange = React.useCallback(
      (nextValue: number) => {
        const snappedValue = snapValue(nextValue, min, max, safeStep);
        dragValueRef.current = snappedValue;
        applyVisualValue(snappedValue);
        if (!isControlled) {
          setUncontrolledValue(snappedValue);
        }
        scheduleChange(snappedValue);
      },
      [applyVisualValue, isControlled, max, min, safeStep, scheduleChange],
    );

    const emitCommit = React.useCallback(
      (nextValue: number) => {
        const snappedValue = snapValue(nextValue, min, max, safeStep);
        if (!isControlled) {
          setUncontrolledValue(snappedValue);
        }
        onValueCommit?.([snappedValue]);
      },
      [isControlled, max, min, onValueCommit, safeStep],
    );

    const getPointerValue = React.useCallback(
      (clientX: number) => {
        const track = trackRef.current;
        if (!track) {
          return displayValue;
        }

        const rect = track.getBoundingClientRect();
        if (rect.width <= 0) {
          return displayValue;
        }

        let ratio = (clientX - rect.left) / rect.width;
        ratio = clampValue(ratio, 0, 1);
        if (shouldInvert) {
          ratio = 1 - ratio;
        }
        return min + ratio * (max - min);
      },
      [displayValue, max, min, shouldInvert],
    );

    const finishPointerDrag = React.useCallback(
      (pointerId: number | null, shouldCommitValue: boolean) => {
        const activePointerId = dragPointerIdRef.current;
        if (activePointerId == null || (pointerId != null && activePointerId !== pointerId)) {
          return;
        }

        const root = rootRef.current;
        if (root?.hasPointerCapture(activePointerId)) {
          root.releasePointerCapture(activePointerId);
        }

        const finalValue = dragValueRef.current ?? committedValue;
        isDraggingRef.current = false;
        dragPointerIdRef.current = null;
        dragValueRef.current = null;
        pendingChangeValueRef.current = null;
        if (changeTimeoutRef.current != null && typeof window !== "undefined") {
          window.clearTimeout(changeTimeoutRef.current);
          changeTimeoutRef.current = null;
        }
        setGlobalSliderCursor(false);
        applyVisualValue(finalValue);

        if (shouldCommitValue) {
          emitCommit(finalValue);
        }
      },
      [applyVisualValue, committedValue, emitCommit],
    );

    const percent = max > min ? ((displayValue - min) / (max - min)) * 100 : 0;
    const visualPercent = shouldInvert ? 100 - percent : percent;
    const centerPercentRaw = max > min ? ((0 - min) / (max - min)) * 100 : 0;
    const centerPercent = shouldInvert ? 100 - centerPercentRaw : centerPercentRaw;
    const centeredRangeStart = Math.min(centerPercent, visualPercent);
    const centeredRangeWidth = Math.abs(centerPercent - visualPercent);

    if (!canUseCustomPointerDrag) {
      return (
        <SliderPrimitive.Root
          ref={ref}
          className={cn(
            "relative flex w-full select-none items-center",
            disabled ? "cursor-not-allowed opacity-50" : "cursor-grab active:cursor-grabbing",
            className,
          )}
          value={value}
          defaultValue={defaultValue}
          min={min}
          max={max}
          step={safeStep}
          disabled={disabled}
          orientation={orientation}
          dir={dir}
          inverted={inverted}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onLostPointerCapture}
          onValueChange={onValueChange}
          onValueCommit={onValueCommit}
          {...props}
        >
          <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-primary/20">
            <SliderPrimitive.Range
              className="absolute h-full transition-all"
              style={{
                background: gradientFill
                  ? "linear-gradient(90deg, hsl(var(--primary) / 0.25) 0%, hsl(var(--primary) / 1) 100%)"
                  : undefined,
              }}
            />
          </SliderPrimitive.Track>
          {Array.from({ length: thumbCount }).map((_, index) => (
            <SliderPrimitive.Thumb
              key={index}
              className={cn(
                "block h-4 w-4 rounded-full border-2 border-primary bg-background shadow-md transition-all hover:scale-125 hover:shadow-lg hover:shadow-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 active:scale-110 disabled:pointer-events-none",
                disabled ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing",
              )}
            />
          ))}
        </SliderPrimitive.Root>
      );
    }

    return (
      <div
        ref={(node) => {
          rootRef.current = node;
          if (typeof ref === "function") {
            ref(node as React.ElementRef<typeof SliderPrimitive.Root>);
          } else if (ref) {
            ref.current = node as React.ElementRef<typeof SliderPrimitive.Root>;
          }
        }}
        className={cn(
          "relative flex w-full touch-none select-none items-center",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-grab active:cursor-grabbing",
          className,
        )}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0 || !rootRef.current) {
            onPointerDown?.(event);
            return;
          }

          event.preventDefault();
          rootRef.current.setPointerCapture(event.pointerId);
          dragPointerIdRef.current = event.pointerId;
          isDraggingRef.current = true;
          setGlobalSliderCursor(true);
          emitChange(getPointerValue(event.clientX));
          onPointerDown?.(event);
        }}
        onPointerMove={(event) => {
          if (!disabled && dragPointerIdRef.current === event.pointerId) {
            event.preventDefault();
            emitChange(getPointerValue(event.clientX));
          }
          onPointerMove?.(event);
        }}
        onPointerUp={(event) => {
          if (!disabled && dragPointerIdRef.current === event.pointerId) {
            finishPointerDrag(event.pointerId, true);
          }
          onPointerUp?.(event);
        }}
        onPointerCancel={(event) => {
          if (!disabled && dragPointerIdRef.current === event.pointerId) {
            finishPointerDrag(event.pointerId, false);
          }
          onPointerCancel?.(event);
        }}
        onLostPointerCapture={(event) => {
          if (!disabled && dragPointerIdRef.current === event.pointerId) {
            finishPointerDrag(event.pointerId, true);
          }
          onLostPointerCapture?.(event);
        }}
        {...props}
      >
        <div ref={trackRef} className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-primary/20">
          <div
            ref={rangeRef}
            className="absolute h-full bg-primary"
            style={
              hasCenteredFill
                ? {
                    left: `${centeredRangeStart}%`,
                    width: `${centeredRangeWidth}%`,
                    background: getRangeBackground(centerPercent, visualPercent) || undefined,
                    transition: "width 36ms linear, left 36ms linear",
                  }
                : shouldInvert
                ? {
                    right: 0,
                    width: `${100 - visualPercent}%`,
                    background: getRangeBackground(100, visualPercent) || undefined,
                    transition: "width 36ms linear",
                  }
                : {
                    width: `${visualPercent}%`,
                    background: getRangeBackground(0, visualPercent) || undefined,
                    transition: "width 36ms linear",
                  }
            }
          />
        </div>
        <div
          ref={thumbRef}
          className={cn(
            "absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow-md hover:scale-125 hover:shadow-lg hover:shadow-primary/25",
            disabled ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing",
          )}
          style={{
            left: `${visualPercent}%`,
            transition: "left 36ms linear, transform 120ms ease, box-shadow 120ms ease",
          }}
        />
      </div>
    );
  },
);

Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
