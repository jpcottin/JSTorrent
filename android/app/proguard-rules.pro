# Keep line numbers for stack traces
-keepattributes SourceFile,LineNumberTable

# Hide original source file name in stack traces
-renamesourcefileattribute SourceFile

# Kotlin Serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Keep serializable classes
-keep,includedescriptorclasses class com.jstorrent.**$$serializer { *; }
-keepclassmembers class com.jstorrent.** {
    *** Companion;
}
-keepclasseswithmembers class com.jstorrent.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Netty (companion server)
-dontwarn io.netty.**
-keep class io.netty.** { *; }

# JNI methods
-keepclasseswithmembernames class * {
    native <methods>;
}
