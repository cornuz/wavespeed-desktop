# FFmpeg Installation for Composer

Composer requires FFmpeg to be installed on your system.

## Installation Instructions

### Windows

**Option 1: Winget (Recommended)**
```powershell
winget install Gyan.FFmpeg
```

**Option 2: Manual Installation**

1. Download FFmpeg essentials from: https://www.gyan.dev/ffmpeg/builds/
2. Extract to a permanent location (e.g., `C:\ffmpeg`)
3. Add `C:\ffmpeg\bin` to your system PATH:
   - Search for "Environment Variables" in Windows
   - Edit "Path" under System variables
   - Add new entry: `C:\ffmpeg\bin`
   - Restart your terminal/IDE

**Option 3: Chocolatey**
```powershell
choco install ffmpeg
```

### macOS

```bash
brew install ffmpeg
```

### Linux (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install ffmpeg
```

## Verify Installation

Run these commands to verify FFmpeg is installed:

```bash
ffmpeg -version
ffprobe -version
```

Both should output version information.

## Why System FFmpeg?

This is the standard approach used by professional open source video editors (Kdenlive, Shotcut, OpenShot):

- ✅ No antivirus/security issues
- ✅ Always up-to-date with system package manager
- ✅ No GitHub repository bloat
- ✅ Single installation for all video editing tools
- ✅ Professional architecture

## License

FFmpeg is licensed under LGPL 2.1+.
