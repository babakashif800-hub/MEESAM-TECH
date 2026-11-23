package com.meesamtech.editor

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pendingWebPermissionRequest: PermissionRequest? = null
    private var lastBackPressMs: Long = 0L

    private val appOriginUrl = "https://appassets.androidplatform.net/index.html"

    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callback = filePathCallback
            filePathCallback = null
            if (callback == null) return@registerForActivityResult

            if (result.resultCode != RESULT_OK || result.data == null) {
                callback.onReceiveValue(null)
                return@registerForActivityResult
            }

            val data = result.data!!
            val uris = mutableListOf<Uri>()
            val clipData = data.clipData
            if (clipData != null && clipData.itemCount > 0) {
                for (i in 0 until clipData.itemCount) {
                    clipData.getItemAt(i)?.uri?.let { uris.add(it) }
                }
            } else {
                data.data?.let { uris.add(it) }
            }
            callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
        }

    private val runtimePermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            val req = pendingWebPermissionRequest
            pendingWebPermissionRequest = null
            if (req != null) {
                val allGranted = grants.values.all { it }
                if (allGranted) {
                    req.grant(req.resources)
                } else {
                    req.deny()
                }
            }
        }

    private val assetLoader: WebViewAssetLoader by lazy {
        WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/") { path ->
                val clean = path.trimStart('/').ifEmpty { "index.html" }
                if (clean.contains("..")) return@addPathHandler null
                try {
                    val stream = assets.open("www/$clean")
                    WebResourceResponse(guessMimeType(clean), "UTF-8", stream)
                } catch (_: IOException) {
                    if (!clean.contains('.')) {
                        try {
                            WebResourceResponse(
                                "text/html",
                                "UTF-8",
                                assets.open("www/index.html")
                            )
                        } catch (_: IOException) {
                            null
                        }
                    } else {
                        null
                    }
                }
            }
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WindowCompat.setDecorFitsSystemWindows(window, true)
        @Suppress("DEPRECATION")
        window.statusBarColor = Color.parseColor("#07080B")
        @Suppress("DEPRECATION")
        window.navigationBarColor = Color.parseColor("#07080B")
        val insetsController = WindowInsetsControllerCompat(window, window.decorView)
        insetsController.isAppearanceLightStatusBars = false
        insetsController.isAppearanceLightNavigationBars = false

        val rootContainer = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#07080B"))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        ViewCompat.setOnApplyWindowInsetsListener(rootContainer) { view, windowInsets ->
            val bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            windowInsets
        }

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#07080B"))
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }

        rootContainer.addView(webView)
        setContentView(rootContainer)

        configureWebView()
        setupBackNavigation()

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            webView.loadUrl(appOriginUrl)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
        }

        webView.addJavascriptInterface(MeesamAndroidBridge(), "MeesamAndroid")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val uri = request?.url ?: return null
                if (uri.host == "appassets.androidplatform.net") {
                    return assetLoader.shouldInterceptRequest(uri)
                }
                return super.shouldInterceptRequest(view, request)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                val serverUrl = BuildConfig.MEESAM_SERVER_URL.trim()
                if (serverUrl.isNotEmpty()) {
                    val escaped = serverUrl.replace("\\", "\\\\").replace("'", "\\'")
                    view?.evaluateJavascript(
                        "window.__MEESAM_API_BASE__ = '$escaped';",
                        null
                    )
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback

                val acceptTypes = fileChooserParams?.acceptTypes
                    ?.filter { it.isNotBlank() }
                    ?.toTypedArray()
                    ?: arrayOf("video/*", "image/*", "audio/*")

                val primaryType = when {
                    acceptTypes.size == 1 -> acceptTypes[0]
                    acceptTypes.any { it.startsWith("audio/") } &&
                        acceptTypes.none { it.startsWith("video/") || it.startsWith("image/") } -> "audio/*"
                    acceptTypes.any { it.startsWith("image/") } &&
                        acceptTypes.none { it.startsWith("video/") || it.startsWith("audio/") } -> "image/*"
                    else -> "*/*"
                }

                val pickIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = primaryType
                    if (acceptTypes.isNotEmpty()) {
                        putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes)
                    }
                    if (fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                }

                return try {
                    fileChooserLauncher.launch(Intent.createChooser(pickIntent, "Select Media"))
                    true
                } catch (_: Exception) {
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = null
                    false
                }
            }

            override fun onPermissionRequest(request: PermissionRequest?) {
                if (request == null) return
                val needAudio = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                if (needAudio &&
                    ContextCompat.checkSelfPermission(
                        this@MainActivity,
                        Manifest.permission.RECORD_AUDIO
                    ) != PackageManager.PERMISSION_GRANTED
                ) {
                    pendingWebPermissionRequest = request
                    runtimePermissionLauncher.launch(arrayOf(Manifest.permission.RECORD_AUDIO))
                    return
                }
                request.grant(request.resources)
            }
        }

        webView.setDownloadListener { url, _, _, mimeType, _ ->
            if (url.startsWith("data:")) {
                val commaIdx = url.indexOf(',')
                if (commaIdx > 5) {
                    val header = url.substring(5, commaIdx)
                    val resolvedMime = header.substringBefore(';').ifEmpty { mimeType ?: "application/octet-stream" }
                    val ext = extensionForMime(resolvedMime)
                    val b64 = url.substring(commaIdx + 1)
                    saveBase64ToDownloads(b64, "meesam-export-${System.currentTimeMillis()}.$ext", resolvedMime)
                }
            }
        }
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                    return
                }
                val now = System.currentTimeMillis()
                if (now - lastBackPressMs < 2000) {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                } else {
                    lastBackPressMs = now
                    Toast.makeText(
                        this@MainActivity,
                        getString(R.string.press_back_again),
                        Toast.LENGTH_SHORT
                    ).show()
                }
            }
        })
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private fun saveBase64ToDownloads(base64Data: String, fileName: String, mimeType: String): Boolean {
        return try {
            val cleanBase64 = if (base64Data.contains(",")) {
                base64Data.substringAfter(",")
            } else {
                base64Data
            }
            val bytes = Base64.decode(cleanBase64, Base64.DEFAULT)
            val safeName = fileName.replace(Regex("[^a-zA-Z0-9._-]"), "_")

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                    put(MediaStore.Downloads.MIME_TYPE, mimeType)
                    put(
                        MediaStore.Downloads.RELATIVE_PATH,
                        "${Environment.DIRECTORY_DOWNLOADS}/MEESAM TECH"
                    )
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: return false
                contentResolver.openOutputStream(uri)?.use { out ->
                    out.write(bytes)
                } ?: return false
            } else {
                @Suppress("DEPRECATION")
                val dir = File(
                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                    "MEESAM TECH"
                )
                if (!dir.exists()) dir.mkdirs()
                val outFile = File(dir, safeName)
                FileOutputStream(outFile).use { out ->
                    out.write(bytes)
                }
                MediaScannerConnection.scanFile(this, arrayOf(outFile.absolutePath), arrayOf(mimeType), null)
            }

            runOnUiThread {
                Toast.makeText(
                    this,
                    getString(R.string.saved_to_downloads, safeName),
                    Toast.LENGTH_LONG
                ).show()
            }
            true
        } catch (e: Exception) {
            runOnUiThread {
                Toast.makeText(
                    this,
                    getString(R.string.save_failed, e.localizedMessage ?: "Storage error"),
                    Toast.LENGTH_LONG
                ).show()
            }
            false
        }
    }

    private fun guessMimeType(path: String): String {
        val lower = path.lowercase()
        return when {
            lower.endsWith(".html") || lower.endsWith(".htm") -> "text/html"
            lower.endsWith(".js") || lower.endsWith(".mjs") -> "application/javascript"
            lower.endsWith(".css") -> "text/css"
            lower.endsWith(".json") -> "application/json"
            lower.endsWith(".wasm") -> "application/wasm"
            lower.endsWith(".tflite") -> "application/octet-stream"
            lower.endsWith(".svg") -> "image/svg+xml"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".webp") -> "image/webp"
            lower.endsWith(".woff2") -> "font/woff2"
            lower.endsWith(".woff") -> "font/woff"
            lower.endsWith(".wav") -> "audio/wav"
            lower.endsWith(".mp3") -> "audio/mpeg"
            lower.endsWith(".mp4") -> "video/mp4"
            else -> "application/octet-stream"
        }
    }

    private fun extensionForMime(mime: String): String {
        return when {
            mime.contains("mp4") -> "mp4"
            mime.contains("webm") -> "webm"
            mime.contains("png") -> "png"
            mime.contains("jpeg") || mime.contains("jpg") -> "jpg"
            mime.contains("wav") -> "wav"
            mime.contains("mpeg") || mime.contains("mp3") -> "mp3"
            mime.contains("aac") || mime.contains("m4a") -> "m4a"
            mime.contains("plain") -> "srt"
            else -> "bin"
        }
    }

    inner class MeesamAndroidBridge {
        @JavascriptInterface
        fun isAndroidApp(): Boolean = true

        @JavascriptInterface
        fun saveBase64File(base64Data: String, fileName: String, mimeType: String): Boolean {
            return saveBase64ToDownloads(base64Data, fileName, mimeType)
        }

        @JavascriptInterface
        fun showToast(message: String) {
            runOnUiThread {
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show()
            }
        }
    }
}
