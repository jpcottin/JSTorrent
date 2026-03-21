#include <jni.h>
#include <android/log.h>
#include <inttypes.h>
#include <string.h>
#include <stdlib.h>
#include "quickjs.h"

#define LOG_TAG "QuickJS-JNI"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define LOGD(...) __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, __VA_ARGS__)

// -----------------------------------------------------------------------------
// ArrayBuffer helpers
// -----------------------------------------------------------------------------

/**
 * Convert Java ByteArray to JS ArrayBuffer.
 * Returns JS_UNDEFINED if data is NULL.
 */
static JSValue byte_array_to_array_buffer(JSContext *ctx, JNIEnv *env, jbyteArray data) {
    if (!data) {
        return JS_UNDEFINED;
    }
    jsize len = (*env)->GetArrayLength(env, data);
    jbyte *bytes = (*env)->GetByteArrayElements(env, data, NULL);

    JSValue arrayBuffer = JS_NewArrayBufferCopy(ctx, (uint8_t *)bytes, len);

    (*env)->ReleaseByteArrayElements(env, data, bytes, JNI_ABORT);
    return arrayBuffer;
}

/**
 * Convert JS ArrayBuffer to Java ByteArray.
 * Returns NULL if val is not an ArrayBuffer.
 */
static jbyteArray array_buffer_to_byte_array(JSContext *ctx, JNIEnv *env, JSValue val) {
    size_t len;
    uint8_t *buf = JS_GetArrayBuffer(ctx, &len, val);

    if (!buf) {
        // Try getting from typed array (e.g., Uint8Array)
        size_t offset, elem_size;
        JSValue abuf = JS_GetTypedArrayBuffer(ctx, val, &offset, &len, &elem_size);
        if (!JS_IsException(abuf)) {
            buf = JS_GetArrayBuffer(ctx, &len, abuf);
            JS_FreeValue(ctx, abuf);
            if (buf) {
                buf += offset;
            }
        }
    }

    if (!buf) {
        return NULL;
    }

    jbyteArray result = (*env)->NewByteArray(env, (jsize)len);
    if (!result || (*env)->ExceptionCheck(env)) {
        return NULL;  // OOM or other pending JNI exception
    }
    (*env)->SetByteArrayRegion(env, result, 0, (jsize)len, (jbyte *)buf);
    if ((*env)->ExceptionCheck(env)) {
        (*env)->DeleteLocalRef(env, result);
        return NULL;
    }
    return result;
}

// -----------------------------------------------------------------------------
// Callback class for storing Kotlin callbacks
// -----------------------------------------------------------------------------
static JSClassID js_callback_class_id = 0;

typedef struct {
    JavaVM *jvm;
    jobject callback;      // Global ref to Kotlin callback
    jmethodID invokeMethod;
} JsCallbackData;

static void js_callback_finalizer(JSRuntime *rt, JSValue val) {
    (void)rt;
    JsCallbackData *data = (JsCallbackData *)JS_GetOpaque(val, js_callback_class_id);
    if (data) {
        // Get JNIEnv to release global ref
        JNIEnv *env = NULL;
        jint status = (*data->jvm)->GetEnv(data->jvm, (void **)&env, JNI_VERSION_1_6);
        if (status == JNI_OK && env) {
            (*env)->DeleteGlobalRef(env, data->callback);
        }
        free(data);
        LOGD("Callback data finalized");
    }
}

static JSClassDef js_callback_class = {
    "JsCallbackData",
    .finalizer = js_callback_finalizer,
};

// -----------------------------------------------------------------------------
// Helper: Convert JS value to Java object
// -----------------------------------------------------------------------------
static jobject js_value_to_jobject(JNIEnv *env, JSContext *ctx, JSValue val) {
    if (JS_IsNull(val) || JS_IsUndefined(val)) {
        return NULL;
    }

    if (JS_IsBool(val)) {
        jclass cls = (*env)->FindClass(env, "java/lang/Boolean");
        jmethodID mid = (*env)->GetStaticMethodID(env, cls, "valueOf", "(Z)Ljava/lang/Boolean;");
        return (*env)->CallStaticObjectMethod(env, cls, mid, JS_ToBool(ctx, val) ? JNI_TRUE : JNI_FALSE);
    }

    if (JS_IsNumber(val)) {
        double d;
        JS_ToFloat64(ctx, &d, val);

        // Check if it's an integer that fits in int32
        if (d == (int64_t)d && d >= -2147483648.0 && d <= 2147483647.0) {
            jclass cls = (*env)->FindClass(env, "java/lang/Integer");
            jmethodID mid = (*env)->GetStaticMethodID(env, cls, "valueOf", "(I)Ljava/lang/Integer;");
            return (*env)->CallStaticObjectMethod(env, cls, mid, (jint)d);
        } else {
            jclass cls = (*env)->FindClass(env, "java/lang/Double");
            jmethodID mid = (*env)->GetStaticMethodID(env, cls, "valueOf", "(D)Ljava/lang/Double;");
            return (*env)->CallStaticObjectMethod(env, cls, mid, d);
        }
    }

    if (JS_IsString(val)) {
        const char *str = JS_ToCString(ctx, val);
        jstring jstr = (*env)->NewStringUTF(env, str);
        JS_FreeCString(ctx, str);
        return jstr;
    }

    // For objects/arrays, return string representation for now
    // Can be extended to return JSObject wrapper
    const char *str = JS_ToCString(ctx, val);
    if (str) {
        jstring jstr = (*env)->NewStringUTF(env, str);
        JS_FreeCString(ctx, str);
        return jstr;
    }

    return NULL;
}

// -----------------------------------------------------------------------------
// Helper: Throw Java exception from JS exception
// -----------------------------------------------------------------------------
static void throw_js_exception(JNIEnv *env, JSContext *ctx) {
    JSValue exception = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, exception);

    jclass cls = (*env)->FindClass(env, "com/jstorrent/quickjs/QuickJsException");
    (*env)->ThrowNew(env, cls, msg ? msg : "Unknown JavaScript error");

    if (msg) JS_FreeCString(ctx, msg);
    JS_FreeValue(ctx, exception);
}

static void log_and_clear_java_exception(JNIEnv *env, const char *context) {
    jthrowable throwable = (*env)->ExceptionOccurred(env);
    if (!throwable) {
        return;
    }
    LOGE("Java exception in %s", context);
    (*env)->ExceptionDescribe(env);
    (*env)->ExceptionClear(env);
}

typedef struct {
    int js_entry_depth;
} QuickJsRuntimeState;

static void throw_quickjs_message(JNIEnv *env, const char *message) {
    jclass cls = (*env)->FindClass(env, "com/jstorrent/quickjs/QuickJsException");
    if (!cls) {
        return;
    }
    (*env)->ThrowNew(env, cls, message);
}

static QuickJsRuntimeState *get_runtime_state(JSContext *ctx) {
    return (QuickJsRuntimeState *)JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
}

static int enter_js_from_kotlin(JNIEnv *env, JSContext *ctx, const char *entrypoint) {
    QuickJsRuntimeState *state = get_runtime_state(ctx);
    if (!state) {
        throw_quickjs_message(env, "QuickJS runtime state unavailable");
        return 0;
    }
    if (state->js_entry_depth > 0) {
        char message[160];
        snprintf(
            message,
            sizeof(message),
            "Re-entrant QuickJS entry blocked in %s; queue work onto the JS thread instead",
            entrypoint
        );
        throw_quickjs_message(env, message);
        return 0;
    }
    state->js_entry_depth++;
    return 1;
}

static void leave_js_from_kotlin(JSContext *ctx) {
    QuickJsRuntimeState *state = get_runtime_state(ctx);
    if (state && state->js_entry_depth > 0) {
        state->js_entry_depth--;
    }
}

// -----------------------------------------------------------------------------
// JNI: Create runtime and context
// Returns: long (pointer to JSContext)
// -----------------------------------------------------------------------------
JNIEXPORT jlong JNICALL
Java_com_jstorrent_quickjs_QuickJsContext_nativeCreate(JNIEnv *env, jclass clazz) {
    (void)clazz;

    JSRuntime *rt = JS_NewRuntime();
    if (!rt) {
        jclass cls = (*env)->FindClass(env, "com/jstorrent/quickjs/QuickJsException");
        (*env)->ThrowNew(env, cls, "Failed to create QuickJS runtime");
        return 0;
    }

    QuickJsRuntimeState *runtime_state = calloc(1, sizeof(QuickJsRuntimeState));
    if (!runtime_state) {
        JS_FreeRuntime(rt);
        jclass cls = (*env)->FindClass(env, "com/jstorrent/quickjs/QuickJsException");
        (*env)->ThrowNew(env, cls, "Failed to allocate QuickJS runtime state");
        return 0;
    }
    JS_SetRuntimeOpaque(rt, runtime_state);

    // Register our callback class if not yet registered
    if (js_callback_class_id == 0) {
        JS_NewClassID(rt, &js_callback_class_id);
    }
    JS_NewClass(rt, js_callback_class_id, &js_callback_class);

    JSContext *ctx = JS_NewContext(rt);
    if (!ctx) {
        JS_SetRuntimeOpaque(rt, NULL);
        free(runtime_state);
        JS_FreeRuntime(rt);
        jclass cls = (*env)->FindClass(env, "com/jstorrent/quickjs/QuickJsException");
        (*env)->ThrowNew(env, cls, "Failed to create QuickJS context");
        return 0;
    }

    LOGD("QuickJS context created: %p", ctx);
    return (jlong)(intptr_t)ctx;
}

// -----------------------------------------------------------------------------
// JNI: Destroy runtime and context
// -----------------------------------------------------------------------------
JNIEXPORT void JNICALL
Java_com_jstorrent_quickjs_QuickJsContext_nativeDestroy(JNIEnv *env, jclass clazz, jlong ctxPtr) {
    (void)env;
    (void)clazz;

    JSContext *ctx = (JSContext *)(intptr_t)ctxPtr;
    if (ctx) {
        JSRuntime *rt = JS_GetRuntime(ctx);
        QuickJsRuntimeState *runtime_state = (QuickJsRuntimeState *)JS_GetRuntimeOpaque(rt);
        JS_FreeContext(ctx);
        JS_SetRuntimeOpaque(rt, NULL);
        free(runtime_state);
        JS_FreeRuntime(rt);
        LOGD("QuickJS context destroyed: %p", ctx);
    }
}

// -----------------------------------------------------------------------------
// JNI: Evaluate JavaScript code
// Returns: Object (boxed primitive, String, or null)
// -----------------------------------------------------------------------------
JNIEXPORT jobject JNICALL
Java_com_jstorrent_quickjs_QuickJsContext_nativeEvaluate(
    JNIEnv *env,
    jclass clazz,
    jlong ctxPtr,
    jstring script,
    jstring filename
) {
    (void)clazz;

    JSContext *ctx = (JSContext *)(intptr_t)ctxPtr;
    if (!enter_js_from_kotlin(env, ctx, "evaluate")) {
        return NULL;
    }

    const char *scriptStr = (*env)->GetStringUTFChars(env, script, NULL);
    const char *filenameStr = (*env)->GetStringUTFChars(env, filename, NULL);

    JSValue result = JS_Eval(ctx, scriptStr, strlen(scriptStr), filenameStr, JS_EVAL_TYPE_GLOBAL);

    (*env)->ReleaseStringUTFChars(env, script, scriptStr);
    (*env)->ReleaseStringUTFChars(env, filename, filenameStr);

    if (JS_IsException(result)) {
        leave_js_from_kotlin(ctx);
        throw_js_exception(env, ctx);
        return NULL;
    }

    jobject jresult = js_value_to_jobject(env, ctx, result);
    JS_FreeValue(ctx, result);
    leave_js_from_kotlin(ctx);

    return jresult;
}

// -----------------------------------------------------------------------------
// JS function that calls back to Kotlin
// -----------------------------------------------------------------------------
static JSValue js_kotlin_callback(
    JSContext *ctx,
    JSValueConst this_val,
    int argc,
    JSValueConst *argv,
    int magic,
    JSValue *func_data
) {
    (void)this_val;
    (void)magic;

    JsCallbackData *data = (JsCallbackData *)JS_GetOpaque(*func_data, js_callback_class_id);
    if (!data) {
        return JS_ThrowInternalError(ctx, "Callback data not found");
    }

    JNIEnv *env;
    int attached = 0;

    // Get JNIEnv for current thread
    jint status = (*data->jvm)->GetEnv(data->jvm, (void **)&env, JNI_VERSION_1_6);
    if (status == JNI_EDETACHED) {
        (*data->jvm)->AttachCurrentThread(data->jvm, &env, NULL);
        attached = 1;
    }

    // Helper macro: check for pending JNI exception (e.g. OOM) and bail out
    // with a JS exception instead of letting ART abort the process.
    #define CHECK_JNI_EXCEPTION() do { \
        if ((*env)->ExceptionCheck(env)) { \
            (*env)->ExceptionClear(env); \
            if (attached) (*data->jvm)->DetachCurrentThread(data->jvm); \
            return JS_ThrowInternalError(ctx, "JNI exception (OOM?) in callback"); \
        } \
    } while (0)

    // Convert JS args to Java String array
    jclass stringClass = (*env)->FindClass(env, "java/lang/String");
    CHECK_JNI_EXCEPTION();
    jobjectArray jargs = (*env)->NewObjectArray(env, argc, stringClass, NULL);
    CHECK_JNI_EXCEPTION();

    for (int i = 0; i < argc; i++) {
        const char *str = JS_ToCString(ctx, argv[i]);
        if (str) {
            jstring jstr = (*env)->NewStringUTF(env, str);
            if ((*env)->ExceptionCheck(env)) {
                (*env)->ExceptionClear(env);
                JS_FreeCString(ctx, str);
                (*env)->DeleteLocalRef(env, jargs);
                if (attached) (*data->jvm)->DetachCurrentThread(data->jvm);
                return JS_ThrowInternalError(ctx, "JNI exception (OOM?) in callback");
            }
            (*env)->SetObjectArrayElement(env, jargs, i, jstr);
            (*env)->DeleteLocalRef(env, jstr);
            JS_FreeCString(ctx, str);
        }
    }

    // Call Kotlin callback: invoke(args: Array<String>): String?
    jstring jresult = (jstring)(*env)->CallObjectMethod(env, data->callback, data->invokeMethod, jargs);
    if ((*env)->ExceptionCheck(env)) {
        (*env)->ExceptionClear(env);
        (*env)->DeleteLocalRef(env, jargs);
        if (attached) (*data->jvm)->DetachCurrentThread(data->jvm);
        return JS_ThrowInternalError(ctx, "Kotlin callback threw exception");
    }

    (*env)->DeleteLocalRef(env, jargs);

    JSValue result = JS_UNDEFINED;
    if (jresult) {
        const char *resultStr = (*env)->GetStringUTFChars(env, jresult, NULL);
        result = JS_NewString(ctx, resultStr);
        (*env)->ReleaseStringUTFChars(env, jresult, resultStr);
        (*env)->DeleteLocalRef(env, jresult);
    }

    if (attached) {
        (*data->jvm)->DetachCurrentThread(data->jvm);
    }

    #undef CHECK_JNI_EXCEPTION
    return result;
}

// -----------------------------------------------------------------------------
// JNI: Set a global function that calls back to Kotlin
// -----------------------------------------------------------------------------
JNIEXPORT void JNICALL
Java_com_jstorrent_quickjs_QuickJsContext_nativeSetGlobalFunction(
    JNIEnv *env,
    jclass clazz,
    jlong ctxPtr,
    jstring name,
    jobject callback
) {
    (void)clazz;

    JSContext *ctx = (JSContext *)(intptr_t)ctxPtr;

    // Get JavaVM reference
    JavaVM *jvm;
    (*env)->GetJavaVM(env, &jvm);

    // Create callback data
    JsCallbackData *data = malloc(sizeof(JsCallbackData));
    data->jvm = jvm;
    data->callback = (*env)->NewGlobalRef(env, callback);

    // Get invoke method
    jclass callbackClass = (*env)->GetObjectClass(env, callback);
    data->invokeMethod = (*env)->GetMethodID(env, callbackClass, "invoke", "([Ljava/lang/String;)Ljava/lang/String;");

    // Create opaque JSValue to hold callback data (with our registered class)
    JSValue funcData = JS_NewObjectClass(ctx, js_callback_class_id);
    JS_SetOpaque(funcData, data);

    // Create JS function with callback (this duplicates funcData internally)
    JSValue func = JS_NewCFunctionData(ctx, js_kotlin_callback, 0, 0, 1, &funcData);

    // Free our local reference to funcData (the function now owns it)
    JS_FreeValue(ctx, funcData);

    // Set on global object
    const char *nameStr = (*env)->GetStringUTFChars(env, name, NULL);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, nameStr, func);
    JS_FreeValue(ctx, global);

    LOGD("Registered global function: %s", nameStr);
    (*env)->ReleaseStringUTFChars(env, name, nameStr);
}

// -----------------------------------------------------------------------------
// JNI: Execute pending jobs (for promises)
// Returns: true if there are more jobs pending
// -----------------------------------------------------------------------------
JNIEXPORT jboolean JNICALL
Java_com_jstorrent_quickjs_QuickJsContext_nativeExecutePendingJob(JNIEnv *env, jclass clazz, jlong ctxPtr) {
    (void)env;
    (void)clazz;

    JSContext *ctx = (JSContext *)(intptr_t)ctxPtr;
    if (!enter_js_from_kotlin(env, ctx, "executePendingJob")) {
        return JNI_FALSE;
    }
    JSContext *ctx2;
    int ret = JS_ExecutePendingJob(JS_GetRuntime(ctx), &ctx2);
    leave_js_from_kotlin(ctx);
    return ret > 0 ? JNI_TRUE : JNI_FALSE;
}

// -----------------------------------------------------------------------------
// Binary callback class for storing Kotlin callbacks that receive ByteArray
// -----------------------------------------------------------------------------
static JSClassID js_binary_callback_class_id = 0;

typedef struct {
    JavaVM *jvm;
    jobject callback;           // Global ref to Kotlin callback
    jmethodID invokeMethod;
    int binaryArgIndex;         // Which argument is the ArrayBuffer (-1 = none)
    int returnsBinary;          // Whether the callback returns ByteArray
} JsBinaryCallbackData;

static void js_binary_callback_finalizer(JSRuntime *rt, JSValue val) {
    (void)rt;
    JsBinaryCallbackData *data = (JsBinaryCallbackData *)JS_GetOpaque(val, js_binary_callback_class_id);
    if (data) {
        JNIEnv *env = NULL;
        jint status = (*data->jvm)->GetEnv(data->jvm, (void **)&env, JNI_VERSION_1_6);
        if (status == JNI_OK && env) {
            (*env)->DeleteGlobalRef(env, data->callback);
        }
        free(data);
        LOGD("Binary callback data finalized");
    }
}

static JSClassDef js_binary_callback_class = {
    "JsBinaryCallbackData",
    .finalizer = js_binary_callback_finalizer,
};

// -----------------------------------------------------------------------------
// JS function that calls back to Kotlin with binary data support
// -----------------------------------------------------------------------------
static JSValue js_kotlin_binary_callback(
    JSContext *ctx,
    JSValueConst this_val,
    int argc,
    JSValueConst *argv,
    int magic,
    JSValue *func_data
) {
    (void)this_val;
    (void)magic;

    JsBinaryCallbackData *data = (JsBinaryCallbackData *)JS_GetOpaque(*func_data, js_binary_callback_class_id);
    if (!data) {
        return JS_ThrowInternalError(ctx, "Binary callback data not found");
    }

    JNIEnv *env;
    int attached = 0;

    jint status = (*data->jvm)->GetEnv(data->jvm, (void **)&env, JNI_VERSION_1_6);
    if (status == JNI_EDETACHED) {
        (*data->jvm)->AttachCurrentThread(data->jvm, &env, NULL);
        attached = 1;
    }

    // Helper macro: check for pending JNI exception (e.g. OOM) and bail out
    // with a JS exception instead of letting ART abort the process.
    #define CHECK_JNI_EXCEPTION() do { \
        if ((*env)->ExceptionCheck(env)) { \
            (*env)->ExceptionClear(env); \
            if (attached) (*data->jvm)->DetachCurrentThread(data->jvm); \
            return JS_ThrowInternalError(ctx, "JNI exception (OOM?) in binary callback"); \
        } \
    } while (0)

    // Build string args array (for non-binary args)
    jclass stringClass = (*env)->FindClass(env, "java/lang/String");
    CHECK_JNI_EXCEPTION();
    jobjectArray jargs = (*env)->NewObjectArray(env, argc, stringClass, NULL);
    CHECK_JNI_EXCEPTION();

    jbyteArray binaryArg = NULL;

    for (int i = 0; i < argc; i++) {
        if (i == data->binaryArgIndex) {
            // This arg is binary - convert to ByteArray
            binaryArg = array_buffer_to_byte_array(ctx, env, argv[i]);
            CHECK_JNI_EXCEPTION();
            // Put placeholder in string array
            (*env)->SetObjectArrayElement(env, jargs, i, NULL);
        } else {
            const char *str = JS_ToCString(ctx, argv[i]);
            if (str) {
                jstring jstr = (*env)->NewStringUTF(env, str);
                if ((*env)->ExceptionCheck(env)) {
                    (*env)->ExceptionClear(env);
                    JS_FreeCString(ctx, str);
                    if (binaryArg) (*env)->DeleteLocalRef(env, binaryArg);
                    (*env)->DeleteLocalRef(env, jargs);
                    if (attached) (*data->jvm)->DetachCurrentThread(data->jvm);
                    return JS_ThrowInternalError(ctx, "JNI exception (OOM?) in binary callback");
                }
                (*env)->SetObjectArrayElement(env, jargs, i, jstr);
                (*env)->DeleteLocalRef(env, jstr);
                JS_FreeCString(ctx, str);
            }
        }
    }

    JSValue result = JS_UNDEFINED;

    if (data->returnsBinary) {
        // Call: invoke(args: Array<String>, binary: ByteArray?): ByteArray?
        jbyteArray jresult = (jbyteArray)(*env)->CallObjectMethod(
            env, data->callback, data->invokeMethod, jargs, binaryArg);

        if ((*env)->ExceptionCheck(env)) {
            log_and_clear_java_exception(env, "js_kotlin_binary_callback returnsBinary");
            if (binaryArg) (*env)->DeleteLocalRef(env, binaryArg);
            (*env)->DeleteLocalRef(env, jargs);
            if (attached) (*data->jvm)->DetachCurrentThread(data->jvm);
            return JS_ThrowInternalError(ctx, "Kotlin binary callback threw exception");
        }

        if (jresult) {
            result = byte_array_to_array_buffer(ctx, env, jresult);
            (*env)->DeleteLocalRef(env, jresult);
        }
    } else {
        // Call: invoke(args: Array<String>, binary: ByteArray?): String?
        jstring jresult = (jstring)(*env)->CallObjectMethod(
            env, data->callback, data->invokeMethod, jargs, binaryArg);

        if ((*env)->ExceptionCheck(env)) {
            log_and_clear_java_exception(env, "js_kotlin_binary_callback returnsString");
            if (binaryArg) (*env)->DeleteLocalRef(env, binaryArg);
            (*env)->DeleteLocalRef(env, jargs);
            if (attached) (*data->jvm)->DetachCurrentThread(data->jvm);
            return JS_ThrowInternalError(ctx, "Kotlin binary callback threw exception");
        }

        if (jresult) {
            const char *resultStr = (*env)->GetStringUTFChars(env, jresult, NULL);
            result = JS_NewString(ctx, resultStr);
            (*env)->ReleaseStringUTFChars(env, jresult, resultStr);
            (*env)->DeleteLocalRef(env, jresult);
        }
    }

    if (binaryArg) (*env)->DeleteLocalRef(env, binaryArg);
    (*env)->DeleteLocalRef(env, jargs);

    if (attached) {
        (*data->jvm)->DetachCurrentThread(data->jvm);
    }

    #undef CHECK_JNI_EXCEPTION
    return result;
}

// -----------------------------------------------------------------------------
// JNI: Set a global function that handles binary data
// binaryArgIndex: which argument is ArrayBuffer (-1 = none)
// returnsBinary: if true, callback returns ByteArray; otherwise String
// -----------------------------------------------------------------------------
JNIEXPORT void JNICALL
Java_com_jstorrent_quickjs_QuickJsContext_nativeSetGlobalFunctionWithBinary(
    JNIEnv *env,
    jclass clazz,
    jlong ctxPtr,
    jstring name,
    jobject callback,
    jint binaryArgIndex,
    jboolean returnsBinary
) {
    (void)clazz;

    JSContext *ctx = (JSContext *)(intptr_t)ctxPtr;
    JSRuntime *rt = JS_GetRuntime(ctx);

    // Register binary callback class if not yet registered
    if (js_binary_callback_class_id == 0) {
        JS_NewClassID(rt, &js_binary_callback_class_id);
        JS_NewClass(rt, js_binary_callback_class_id, &js_binary_callback_class);
    }

    JavaVM *jvm;
    (*env)->GetJavaVM(env, &jvm);

    JsBinaryCallbackData *data = malloc(sizeof(JsBinaryCallbackData));
    data->jvm = jvm;
    data->callback = (*env)->NewGlobalRef(env, callback);
    data->binaryArgIndex = binaryArgIndex;
    data->returnsBinary = returnsBinary ? 1 : 0;

    jclass callbackClass = (*env)->GetObjectClass(env, callback);
    if (returnsBinary) {
        // invoke(Array<String>, ByteArray?): ByteArray?
        data->invokeMethod = (*env)->GetMethodID(env, callbackClass, "invoke",
            "([Ljava/lang/String;[B)[B");
    } else {
        // invoke(Array<String>, ByteArray?): String?
        data->invokeMethod = (*env)->GetMethodID(env, callbackClass, "invoke",
            "([Ljava/lang/String;[B)Ljava/lang/String;");
    }

    JSValue funcData = JS_NewObjectClass(ctx, js_binary_callback_class_id);
    JS_SetOpaque(funcData, data);

    JSValue func = JS_NewCFunctionData(ctx, js_kotlin_binary_callback, 0, 0, 1, &funcData);
    JS_FreeValue(ctx, funcData);

    const char *nameStr = (*env)->GetStringUTFChars(env, name, NULL);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, nameStr, func);
    JS_FreeValue(ctx, global);

    LOGD("Registered binary global function: %s (binaryArg=%d, returnsBinary=%d)",
         nameStr, binaryArgIndex, returnsBinary);
    (*env)->ReleaseStringUTFChars(env, name, nameStr);
}

// -----------------------------------------------------------------------------
// JNI: Call a global JS function from Kotlin
// Returns the result as a Java object (String, Boolean, Integer, Double, ByteArray, or null)
// -----------------------------------------------------------------------------
JNIEXPORT jobject JNICALL
Java_com_jstorrent_quickjs_QuickJsContext_nativeCallGlobalFunction(
    JNIEnv *env,
    jclass clazz,
    jlong ctxPtr,
    jstring funcName,
    jobjectArray args,
    jbyteArray binaryArg,
    jint binaryArgIndex
) {
    (void)clazz;

    JSContext *ctx = (JSContext *)(intptr_t)ctxPtr;
    if (!enter_js_from_kotlin(env, ctx, "callGlobalFunction")) {
        return NULL;
    }

    // Get the global function
    const char *funcNameStr = (*env)->GetStringUTFChars(env, funcName, NULL);
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue func = JS_GetPropertyStr(ctx, global, funcNameStr);
    (*env)->ReleaseStringUTFChars(env, funcName, funcNameStr);

    if (!JS_IsFunction(ctx, func)) {
        JS_FreeValue(ctx, func);
        JS_FreeValue(ctx, global);
        leave_js_from_kotlin(ctx);
        return NULL;  // Function not found
    }

    // Build args array
    // argc must account for both string args and the binary arg position,
    // since binaryArgIndex can be beyond the string array bounds.
    int stringArgCount = args ? (*env)->GetArrayLength(env, args) : 0;
    int argc = (binaryArg && binaryArgIndex >= stringArgCount)
        ? binaryArgIndex + 1
        : stringArgCount;
    JSValue *jsArgs = argc > 0 ? malloc(sizeof(JSValue) * argc) : NULL;

    int stringIdx = 0;
    for (int i = 0; i < argc; i++) {
        if (i == binaryArgIndex && binaryArg) {
            jsArgs[i] = byte_array_to_array_buffer(ctx, env, binaryArg);
        } else if (stringIdx < stringArgCount) {
            jstring jstr = (jstring)(*env)->GetObjectArrayElement(env, args, stringIdx);
            if (jstr) {
                const char *str = (*env)->GetStringUTFChars(env, jstr, NULL);
                jsArgs[i] = JS_NewString(ctx, str);
                (*env)->ReleaseStringUTFChars(env, jstr, str);
                (*env)->DeleteLocalRef(env, jstr);
            } else {
                jsArgs[i] = JS_UNDEFINED;
            }
            stringIdx++;
        } else {
            jsArgs[i] = JS_UNDEFINED;
        }
    }

    // Call the function
    JSValue result = JS_Call(ctx, func, global, argc, jsArgs);

    // Free args
    for (int i = 0; i < argc; i++) {
        JS_FreeValue(ctx, jsArgs[i]);
    }
    if (jsArgs) free(jsArgs);
    JS_FreeValue(ctx, func);
    JS_FreeValue(ctx, global);

    if (JS_IsException(result)) {
        leave_js_from_kotlin(ctx);
        throw_js_exception(env, ctx);
        return NULL;
    }

    // Convert result - check for ArrayBuffer first
    jbyteArray binaryResult = array_buffer_to_byte_array(ctx, env, result);
    if ((*env)->ExceptionCheck(env)) {
        JS_FreeValue(ctx, result);
        leave_js_from_kotlin(ctx);
        return NULL;
    }
    if (binaryResult) {
        JS_FreeValue(ctx, result);
        leave_js_from_kotlin(ctx);
        return binaryResult;
    }

    jobject jresult = js_value_to_jobject(env, ctx, result);
    JS_FreeValue(ctx, result);
    leave_js_from_kotlin(ctx);

    return jresult;
}

// -----------------------------------------------------------------------------
// JNI: Compute QuickJS runtime memory usage
// Returns JSON string with JSMemoryUsage fields
// -----------------------------------------------------------------------------
JNIEXPORT jstring JNICALL
Java_com_jstorrent_quickjs_QuickJsContext_nativeComputeMemoryUsage(
    JNIEnv *env,
    jclass clazz,
    jlong ctxPtr
) {
    (void)clazz;

    JSContext *ctx = (JSContext *)(intptr_t)ctxPtr;
    if (!ctx) {
        return NULL;
    }

    JSRuntime *rt = JS_GetRuntime(ctx);
    JSMemoryUsage stats;
    JS_ComputeMemoryUsage(rt, &stats);

    char json[2048];
    int written = snprintf(
        json,
        sizeof(json),
        "{"
        "\"mallocSize\":%" PRId64 ","
        "\"mallocLimit\":%" PRId64 ","
        "\"memoryUsedSize\":%" PRId64 ","
        "\"mallocCount\":%" PRId64 ","
        "\"memoryUsedCount\":%" PRId64 ","
        "\"atomCount\":%" PRId64 ","
        "\"atomSize\":%" PRId64 ","
        "\"strCount\":%" PRId64 ","
        "\"strSize\":%" PRId64 ","
        "\"objCount\":%" PRId64 ","
        "\"objSize\":%" PRId64 ","
        "\"propCount\":%" PRId64 ","
        "\"propSize\":%" PRId64 ","
        "\"shapeCount\":%" PRId64 ","
        "\"shapeSize\":%" PRId64 ","
        "\"jsFuncCount\":%" PRId64 ","
        "\"jsFuncSize\":%" PRId64 ","
        "\"jsFuncCodeSize\":%" PRId64 ","
        "\"jsFuncPc2lineCount\":%" PRId64 ","
        "\"jsFuncPc2lineSize\":%" PRId64 ","
        "\"cFuncCount\":%" PRId64 ","
        "\"arrayCount\":%" PRId64 ","
        "\"fastArrayCount\":%" PRId64 ","
        "\"fastArrayElements\":%" PRId64 ","
        "\"binaryObjectCount\":%" PRId64 ","
        "\"binaryObjectSize\":%" PRId64
        "}",
        stats.malloc_size,
        stats.malloc_limit,
        stats.memory_used_size,
        stats.malloc_count,
        stats.memory_used_count,
        stats.atom_count,
        stats.atom_size,
        stats.str_count,
        stats.str_size,
        stats.obj_count,
        stats.obj_size,
        stats.prop_count,
        stats.prop_size,
        stats.shape_count,
        stats.shape_size,
        stats.js_func_count,
        stats.js_func_size,
        stats.js_func_code_size,
        stats.js_func_pc2line_count,
        stats.js_func_pc2line_size,
        stats.c_func_count,
        stats.array_count,
        stats.fast_array_count,
        stats.fast_array_elements,
        stats.binary_object_count,
        stats.binary_object_size
    );

    if (written < 0 || written >= (int)sizeof(json)) {
        LOGE("Failed to format QuickJS memory usage JSON");
        return NULL;
    }

    return (*env)->NewStringUTF(env, json);
}
