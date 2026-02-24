package com.jstorrent.app.ui.screens

import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.DeleteForever
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.jstorrent.app.BuildConfig
import com.jstorrent.app.R
import com.jstorrent.app.ui.dialogs.ClearAllDataDialog
import com.jstorrent.app.ui.dialogs.ResetSettingsDialog
import com.jstorrent.app.viewmodel.SettingsViewModel

private val LANGUAGE_OPTIONS = listOf(
    "cs" to "Čeština",
    "da" to "Dansk",
    "de" to "Deutsch",
    "es" to "Español",
    "fr" to "Français",
    "it" to "Italiano",
    "ja" to "日本語",
    "ko" to "한국어",
    "nl" to "Nederlands",
    "pl" to "Polski",
    "pt-BR" to "Português (Brasil)",
    "ro" to "Română",
    "ru" to "Русский",
    "sv" to "Svenska",
    "tr" to "Türkçe",
    "uk" to "Українська",
    "zh-CN" to "简体中文",
    "zh-TW" to "繁體中文"
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AdvancedSettingsScreen(
    viewModel: SettingsViewModel,
    onNavigateBack: () -> Unit,
    onClearAllDataCompleted: () -> Unit = {},
    isChromebook: Boolean = false,
    onSwitchToCompanionMode: (() -> Unit)? = null,
    modifier: Modifier = Modifier
) {
    val uiState by viewModel.uiState.collectAsState()
    val context = LocalContext.current

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_advanced_title)) },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.back)
                        )
                    }
                }
            )
        }
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            // Language picker
            item {
                SectionHeader(title = stringResource(R.string.settings_advanced_language_section))
            }

            item {
                val systemDefault = stringResource(R.string.settings_advanced_language_system_default)
                val allOptions = listOf("" to systemDefault) + LANGUAGE_OPTIONS
                val currentTag = uiState.appLocale
                val currentOption = allOptions.find { it.first == currentTag } ?: allOptions[0]

                SettingDropdownRow(
                    label = stringResource(R.string.settings_advanced_language_label),
                    currentValue = currentOption,
                    options = allOptions,
                    labelFor = { it.second },
                    onValueChange = { viewModel.setAppLocale(it.first) },
                    modifier = Modifier.padding(horizontal = 16.dp)
                )
            }

            // Chromebook-only: Switch to Companion Mode
            if (isChromebook && onSwitchToCompanionMode != null) {
                item {
                    SectionHeader(title = stringResource(R.string.settings_advanced_mode_section))
                }

                item {
                    SwitchToCompanionModeButton(onClick = onSwitchToCompanionMode)
                }
            }

            item {
                SectionHeader(title = stringResource(R.string.settings_advanced_support_section))
            }

            item {
                ReportBugButton(
                    onClick = {
                        val feedbackUrl = buildFeedbackUrl()
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(feedbackUrl))
                        context.startActivity(intent)
                    }
                )
            }

            item {
                SectionHeader(title = stringResource(R.string.settings_advanced_reset_section))
            }

            item {
                ResetSettingsButton(
                    onClick = { viewModel.showResetSettingsConfirmation() }
                )
            }

            item {
                ClearAllDataButton(
                    onClick = { viewModel.showClearAllDataConfirmation() }
                )
            }
        }
    }

    // Reset settings confirmation dialog
    if (uiState.showResetSettingsConfirmation) {
        ResetSettingsDialog(
            onDismiss = { viewModel.dismissResetSettingsConfirmation() },
            onConfirm = { viewModel.resetSettings() }
        )
    }

    // Clear all data confirmation dialog
    if (uiState.showClearAllDataConfirmation) {
        ClearAllDataDialog(
            onDismiss = { viewModel.dismissClearAllDataConfirmation() },
            onConfirm = { deleteFiles ->
                viewModel.clearAllData(deleteFiles)
                onClearAllDataCompleted()
            }
        )
    }
}

@Composable
private fun SwitchToCompanionModeButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.3f)
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = Icons.Default.Sync,
                contentDescription = null,
                modifier = Modifier.size(24.dp),
                tint = MaterialTheme.colorScheme.primary
            )
            Spacer(modifier = Modifier.width(12.dp))
            Column {
                Text(
                    text = stringResource(R.string.settings_advanced_companion_mode_label),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.primary
                )
                Text(
                    text = stringResource(R.string.settings_advanced_companion_mode_description),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun ResetSettingsButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = Icons.Default.Refresh,
                contentDescription = null,
                modifier = Modifier.size(24.dp),
                tint = MaterialTheme.colorScheme.primary
            )
            Spacer(modifier = Modifier.width(12.dp))
            Column {
                Text(
                    text = stringResource(R.string.settings_advanced_reset_settings_label),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Text(
                    text = stringResource(R.string.settings_advanced_reset_settings_description),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun ClearAllDataButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.3f)
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = Icons.Default.DeleteForever,
                contentDescription = null,
                modifier = Modifier.size(24.dp),
                tint = MaterialTheme.colorScheme.error
            )
            Spacer(modifier = Modifier.width(12.dp))
            Column {
                Text(
                    text = stringResource(R.string.settings_advanced_clear_all_data_label),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.error
                )
                Text(
                    text = stringResource(R.string.settings_advanced_clear_all_data_description),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
            }
        }
    }
}

@Composable
private fun ReportBugButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = Icons.Default.BugReport,
                contentDescription = null,
                modifier = Modifier.size(24.dp),
                tint = MaterialTheme.colorScheme.primary
            )
            Spacer(modifier = Modifier.width(12.dp))
            Column {
                Text(
                    text = stringResource(R.string.settings_advanced_report_bug_label),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Text(
                    text = stringResource(R.string.settings_advanced_report_bug_description),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

private fun buildFeedbackUrl(): String {
    val baseUrl = "https://new.jstorrent.com/feedback.html"
    val params = buildString {
        append("?platform=android")
        append("&v=${BuildConfig.VERSION_NAME}")
        append("&android=${Build.VERSION.RELEASE}")
        append("&device=${Uri.encode("${Build.MANUFACTURER} ${Build.MODEL}")}")
    }
    return baseUrl + params
}
