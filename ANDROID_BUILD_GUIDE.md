# MEESAM TECH — Android Studio & APK Build Guide

Your complete native Android Gradle project is located in the `/android` folder (`com.meesamtech.editor`, Min SDK 24 / Android 7.0+, Target SDK 35 / Android 15).

All editing tools — trimming, splitting, speed curves, 144 video effects, 201 filters, built-in music library, audio mixer & trimming, multilingual text/stickers, keyframes, and MP4/PNG export — are bundled offline inside `android/app/src/main/assets/www/` and served securely by `WebViewAssetLoader`. Exported videos, photos, WAV voices, and SRT captions automatically save directly into **`Downloads/MEESAM TECH/`** on the Android device.

---

## Option 1: Build APK in Android Studio (Easiest)

1. Whenever you edit web code, refresh the Android bundle first:
   ```bash
   npm run android:prepare
   ```
2. Open **Android Studio** -> **Open** -> select the `/android` folder.
3. Wait for Gradle Sync to finish (Android Studio automatically provisions Gradle 8.9 & Android SDK 35).
4. Choose **Build -> Build Bundle(s) / APK(s) -> Build APK(s)**.
5. Your installable APK is generated at:
   `android/app/build/outputs/apk/debug/app-debug.apk`

---

## Option 2: Build APK from Command Line

Make sure **JDK 17** and **Android SDK (Platform 35 + Build-Tools 35)** are installed, then:

```bash
npm run android:prepare
cd android
gradle wrapper      # Only needed once if gradle-wrapper.jar isn't present yet
./gradlew assembleDebug
```

Debug APK output:
`android/app/build/outputs/apk/debug/app-debug.apk`

---

## Option 3: Build a Signed Release APK (Play Store / Distribution)

1. Generate a release keystore:
   ```bash
   keytool -genkey -v -keystore android/meesam-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias meesamtech
   ```
2. Create `android/keystore.properties` (kept gitignored):
   ```properties
   storeFile=meesam-release.jks
   storePassword=YOUR_STORE_PASSWORD
   keyAlias=meesamtech
   keyPassword=YOUR_KEY_PASSWORD
   ```
3. Build release APK:
   ```bash
   cd android
   ./gradlew assembleRelease
   ```
   Output: `android/app/build/outputs/apk/release/app-release.apk`

---

## Option 4: Cloud APK Build via GitHub Actions (No Local Android Studio Needed)

1. Push this project to a GitHub repository (`main` or `master` branch).
2. Open your repository on GitHub and click the **Actions** tab.
3. Select **Build MEESAM TECH Android APK** (if it hasn't started automatically from your push, click **Run workflow** -> **Run workflow**).
4. Wait ~2–3 minutes for the **Build app-debug.apk** job to finish with a green checkmark.
5. Click the completed workflow run, scroll down to **Artifacts**, and click **`MEESAM-TECH-app-debug-apk`** to download the zip file.
6. Unzip it — inside is **`app-debug.apk`**. Transfer it to your Android phone and tap it to install (enable *Install unknown apps* if prompted).

---

## Optional: Connecting Online AI Features (AI Voice / Auto Captions / Translate) Inside the APK

Core editing and exporting run 100% offline inside the APK. If you deploy the Node/Express backend (`npm start`) to a public HTTPS URL and want AI Voice/Captions/Translate inside the installed APK to reach it, set `MEESAM_SERVER_URL` in `android/gradle.properties`:

```properties
MEESAM_SERVER_URL=https://your-deployed-meesamtech-server.example.com
```
