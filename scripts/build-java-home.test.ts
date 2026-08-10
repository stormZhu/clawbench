import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const buildScript = readFileSync(resolve(__dirname, '../build.sh'), 'utf8')

describe('Android JDK resolution in build.sh', () => {
    it('uses a valid JAVA_HOME before platform-specific discovery', () => {
        expect(buildScript).toContain('resolve_java_home()')
        expect(buildScript).toContain('[ -x "${JAVA_HOME}/bin/java" ]')
        expect(buildScript).toContain('echo "$JAVA_HOME"')
    })

    it('discovers JDK 17 on macOS and common Homebrew installations', () => {
        expect(buildScript).toContain('/usr/libexec/java_home -v 17')
        expect(buildScript).toContain('/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home')
        expect(buildScript).toContain('/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home')
    })

    it('passes the resolved JDK to Gradle instead of hardcoding a Linux path', () => {
        expect(buildScript).toContain('JAVA_HOME="$ANDROID_JAVA_HOME" ./gradlew assembleRelease')
        expect(buildScript).not.toContain('JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ./gradlew')
    })

    it('ensures a local release keystore before invoking Gradle', () => {
        const ensureIndex = buildScript.indexOf('ensure_android_keystore "android/clawbench.jks"')
        const gradleIndex = buildScript.indexOf('JAVA_HOME="$ANDROID_JAVA_HOME" ./gradlew assembleRelease')

        expect(ensureIndex).toBeGreaterThan(-1)
        expect(gradleIndex).toBeGreaterThan(ensureIndex)
    })
})
