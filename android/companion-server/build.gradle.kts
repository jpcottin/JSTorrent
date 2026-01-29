plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.jstorrent.companion"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "/META-INF/INDEX.LIST"
            excludes += "/META-INF/io.netty.versions.properties"
        }
    }
}

dependencies {
    // Depend on io-core
    implementation(project(":io-core"))

    // Ktor server (HTTP/WebSocket)
    implementation(libs.ktor.server.core)
    implementation(libs.ktor.server.netty)
    implementation(libs.ktor.server.websockets)

    // Direct Netty dependencies for raw WebSocket server (Phase 3)
    // These are transitively available via ktor-server-netty, but we declare them
    // explicitly for clarity and to ensure the correct modules are available.
    implementation("io.netty:netty-codec-http:4.1.100.Final")
    implementation("io.netty:netty-handler:4.1.100.Final")

    // Java-WebSocket for high-throughput /io endpoint (Phase 5)
    // This library achieves 8x better throughput than Ktor WebSocket
    implementation(libs.java.websocket)

    // Coroutines
    implementation(libs.kotlinx.coroutines.android)

    // JSON serialization
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.junit)
    testImplementation(libs.ktor.server.tests)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.kotlin.test)
}
