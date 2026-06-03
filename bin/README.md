# FFmpeg Binaries for Development

This directory should contain the FFmpeg binaries needed for Composer development:

- `ffmpeg.exe`
- `ffprobe.exe`

## Download Instructions

1. Visit https://www.gyan.dev/ffmpeg/builds/
2. Download `ffmpeg-8.1.1-essentials_build.7z` (~80 MB)
3. Extract the archive
4. Copy `ffmpeg.exe` and `ffprobe.exe` from `ffmpeg-8.1.1-essentials_build/bin/` to this directory

## Notes

- These binaries are **not tracked in git** (listed in `.gitignore`)
- In production builds, FFmpeg is automatically bundled via `extraResources` in `package.json`
- The essentials build contains H.264, AAC, and basic filters — sufficient for Composer's needs
- Full build (~230 MB) is only needed for VP9/HEVC/AV1 export or hardware encoding

## License

FFmpeg is licensed under LGPL 2.1+. See `resources/licenses/ffmpeg-license.txt` for details.
