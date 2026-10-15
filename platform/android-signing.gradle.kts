import com.android.build.gradle.internal.dsl.BaseAppModuleExtension
val store = System.getenv("RELAKEEP_ANDROID_KEYSTORE")
if (store != null) {
    extensions.configure<BaseAppModuleExtension> {
        signingConfigs.create("relakeepRelease") {
            storeFile = file(store)
            storePassword = System.getenv("RELAKEEP_ANDROID_STORE_PASSWORD") ?: error("缺少 Android keystore 密码")
            keyAlias = "relakeep"
            keyPassword = System.getenv("RELAKEEP_ANDROID_KEY_PASSWORD") ?: error("缺少 Android key 密码")
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("relakeepRelease")
    }
}
