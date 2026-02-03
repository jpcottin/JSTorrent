package com.jstorrent.app.review

import android.app.Activity
import android.util.Log
import com.google.android.play.core.review.ReviewException
import com.google.android.play.core.review.ReviewManagerFactory
import com.google.android.play.core.review.model.ReviewErrorCode

private const val TAG = "ReviewHelper"

/**
 * Helper for launching the Google Play In-App Review flow.
 *
 * The In-App Review API shows a native Play Store review sheet without
 * leaving the app. Note that Google quota-limits how often the sheet actually
 * appears, so we can't guarantee it will show.
 *
 * Usage:
 * ```
 * ReviewHelper.launchReviewFlow(activity) { success ->
 *     // success indicates if the flow completed (not necessarily if user left review)
 * }
 * ```
 */
object ReviewHelper {

    /**
     * Launch the In-App Review flow.
     *
     * @param activity The activity to launch the review flow from
     * @param onComplete Callback when flow completes or fails. Boolean indicates success.
     *                   Note: "success" means the flow was shown, NOT that user left a review.
     *                   Google doesn't tell us if the user actually reviewed.
     */
    fun launchReviewFlow(activity: Activity, onComplete: (Boolean) -> Unit = {}) {
        val reviewManager = ReviewManagerFactory.create(activity)

        Log.i(TAG, "Requesting review flow...")
        val request = reviewManager.requestReviewFlow()

        request.addOnCompleteListener { task ->
            if (task.isSuccessful) {
                val reviewInfo = task.result
                Log.i(TAG, "Review flow request successful, launching...")

                val flow = reviewManager.launchReviewFlow(activity, reviewInfo)
                flow.addOnCompleteListener { launchTask ->
                    if (launchTask.isSuccessful) {
                        Log.i(TAG, "Review flow completed successfully")
                        onComplete(true)
                    } else {
                        val exception = launchTask.exception
                        logReviewError("launch", exception)
                        onComplete(false)
                    }
                }
            } else {
                val exception = task.exception
                logReviewError("request", exception)
                onComplete(false)
            }
        }
    }

    private fun logReviewError(phase: String, exception: Exception?) {
        if (exception is ReviewException) {
            val errorCode = exception.errorCode
            val errorName = when (errorCode) {
                ReviewErrorCode.NO_ERROR -> "NO_ERROR"
                ReviewErrorCode.PLAY_STORE_NOT_FOUND -> "PLAY_STORE_NOT_FOUND"
                ReviewErrorCode.INVALID_REQUEST -> "INVALID_REQUEST"
                ReviewErrorCode.INTERNAL_ERROR -> "INTERNAL_ERROR"
                else -> "UNKNOWN($errorCode)"
            }
            Log.w(TAG, "Review flow $phase failed: $errorName")
        } else {
            Log.w(TAG, "Review flow $phase failed", exception)
        }
    }
}
