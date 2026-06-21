# Android Build on Windows

The Android Gradle build toolchain has a known issue on Windows with long file paths. The default `ninja.exe` bundled with CMake hits `MAX_PATH` (260 character) limits during the build, causing failures in deep module trees.

Two steps are required to make Android builds work on Windows.

## 1. Enable Long File Paths

Enable the Windows long path policy via registry. Open PowerShell as Administrator and run:

```powershell
Set-ItemProperty -Path 'HKLM:SYSTEM\CurrentControlSet\Control\FileSystem' -Name 'LongPathsEnabled' -Value 1
```

A reboot is not required, but any running build tools should be restarted.

## 2. Replace ninja.exe

The ninja version shipped with Android SDK CMake does not support long paths. Replace it with a version that does.

1. Download a long-path-aware ninja build from the [official releases](https://github.com/ninja-build/ninja/releases). Grab `ninja-win.zip` from the latest release.

2. Extract `ninja.exe` from the zip.

3. Find your Android SDK's CMake ninja. The path is typically:

   ```
   %LOCALAPPDATA%\Android\Sdk\cmake\<version>\bin\ninja.exe
   ```

   For example:
   ```
   %LOCALAPPDATA%\Android\Sdk\cmake\3.22.1\bin\ninja.exe
   ```

   If you have multiple CMake versions installed, you'll need to replace `ninja.exe` in each one.

4. Back up the original `ninja.exe` (rename it to `ninja.exe.bak`), then copy the downloaded one into its place.

## Verify

Run the Android build:

```sh
npx expo run:android
```

Or build the Gradle wrapper directly:

```sh
cd android
.\gradlew assembleDebug
```

If the build completes without path-too-long errors, the setup is correct.
