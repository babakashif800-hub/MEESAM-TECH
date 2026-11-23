#!/bin/sh

APP_HOME=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
WRAPPER_JAR="$APP_HOME/gradle/wrapper/gradle-wrapper.jar"

if [ ! -f "$WRAPPER_JAR" ]; then
  if command -v gradle >/dev/null 2>&1; then
    exec gradle "$@"
  else
    echo "gradle-wrapper.jar is not present yet." >&2
    echo "Open /android in Android Studio (Sync Project) or run 'gradle wrapper' once." >&2
    exit 1
  fi
fi

exec java -Xmx256m -classpath "$WRAPPER_JAR" org.gradle.wrapper.GradleWrapperMain "$@"
