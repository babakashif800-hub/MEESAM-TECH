@echo off
setlocal
set DIRNAME=%~dp0
set WRAPPER_JAR=%DIRNAME%gradle\wrapper\gradle-wrapper.jar

if exist "%WRAPPER_JAR%" (
  java -Xmx256m -classpath "%WRAPPER_JAR%" org.gradle.wrapper.GradleWrapperMain %*
  exit /b %ERRORLEVEL%
)

where gradle >nul 2>nul
if %ERRORLEVEL% equ 0 (
  gradle %*
  exit /b %ERRORLEVEL%
)

echo gradle-wrapper.jar is not present yet.
echo Open /android in Android Studio or run "gradle wrapper" once to bootstrap it.
exit /b 1
