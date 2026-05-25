# Android APK Build Notes

The current mobile preview is available at:

```text
http://localhost:5173/mobile.html
```

Before building a real APK, two things are required:

1. Android build tooling on the computer:
   - Android Studio
   - Android SDK
   - Gradle/Android Gradle Plugin

2. A mobile-safe sync path:
   - A phone APK cannot use the computer's `http://localhost:5173`.
   - `localhost` inside Android means the phone itself.
   - The APK should either load a hosted HTTPS version of the app or use a backend sync API.

Recommended route:

1. Deploy the app or sync API to an HTTPS host.
2. Keep the service role key on a server, not inside the APK.
3. Build the Android app as a WebView/Capacitor shell that loads the HTTPS mobile UI.
4. After sync is stable, produce a debug APK, then a signed release APK.

Current environment status:

- Java is installed.
- Android SDK is not installed.
- Gradle is not installed.
- `adb` and `sdkmanager` are not installed.

So this repository can prepare the mobile UI, but this machine cannot compile an APK until Android tooling is installed.
