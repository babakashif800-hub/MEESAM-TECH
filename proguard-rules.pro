# Keep MEESAM TECH WebView JavaScript Bridge intact for Release APKs
-keepclassmembers class com.meesamtech.editor.MainActivity$MeesamAndroidBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
-keepattributes *Annotation*
