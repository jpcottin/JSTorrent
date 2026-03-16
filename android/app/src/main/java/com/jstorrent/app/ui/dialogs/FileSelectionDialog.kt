package com.jstorrent.app.ui.dialogs

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jstorrent.app.storage.DownloadRoot
import com.jstorrent.app.util.Formatters
import com.jstorrent.quickjs.model.FileInfo

/**
 * File selection dialog shown when adding a torrent with "show file selection" enabled.
 * Lets the user pick download location and choose which files to download.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FileSelectionDialog(
    torrentName: String,
    hasMetadata: Boolean,
    files: List<FileInfo>,
    roots: List<DownloadRoot>,
    rootFreeSpace: Map<String, Long>,
    defaultRootKey: String?,
    queueCount: Int,
    onConfirm: (rootKey: String, selectedFileIndices: Set<Int>) -> Unit,
    onConfirmAll: (rootKey: String) -> Unit,
    onCancel: () -> Unit,
    onDontShowAgain: () -> Unit,
    onAddRootClick: () -> Unit,
    onDismiss: () -> Unit
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var selectedRootKey by remember {
        mutableStateOf(defaultRootKey ?: roots.firstOrNull()?.key ?: "")
    }
    // Update selection when roots load asynchronously
    LaunchedEffect(defaultRootKey) {
        if (selectedRootKey.isEmpty() && defaultRootKey != null) {
            selectedRootKey = defaultRootKey
        }
    }
    var selectedFiles by remember { mutableStateOf(files.map { it.index }.toSet()) }
    // Update selected files when metadata arrives
    if (hasMetadata && files.isNotEmpty() && selectedFiles.isEmpty()) {
        selectedFiles = files.map { it.index }.toSet()
    }

    val selectedSize = files.filter { it.index in selectedFiles }.sumOf { it.size }
    val freeSpace = rootFreeSpace[selectedRootKey]
    val overCapacity = freeSpace != null && freeSpace > 0 && selectedSize > freeSpace

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp)
        ) {
            // Torrent name
            Text(
                text = torrentName,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            if (queueCount > 0) {
                Text(
                    text = "+$queueCount more waiting",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Download location dropdown
            RootDropdown(
                roots = roots,
                rootFreeSpace = rootFreeSpace,
                selectedKey = selectedRootKey,
                onSelect = { selectedRootKey = it },
                onAddRootClick = onAddRootClick
            )

            Spacer(modifier = Modifier.height(16.dp))

            // File tree or loading spinner
            if (!hasMetadata) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(120.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(modifier = Modifier.size(32.dp))
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = "Fetching metadata...",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            } else if (files.isNotEmpty()) {
                // Select all / deselect all
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "${selectedFiles.size}/${files.size} files",
                        style = MaterialTheme.typography.labelMedium
                    )
                    Row {
                        Text(
                            text = "All",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.clickable {
                                selectedFiles = files.map { it.index }.toSet()
                            }
                        )
                        Spacer(modifier = Modifier.width(16.dp))
                        Text(
                            text = "None",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.clickable {
                                selectedFiles = emptySet()
                            }
                        )
                    }
                }

                Spacer(modifier = Modifier.height(4.dp))

                // File list
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 300.dp)
                ) {
                    items(files, key = { it.index }) { file ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    selectedFiles = if (file.index in selectedFiles) {
                                        selectedFiles - file.index
                                    } else {
                                        selectedFiles + file.index
                                    }
                                }
                                .padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Checkbox(
                                checked = file.index in selectedFiles,
                                onCheckedChange = { checked ->
                                    selectedFiles = if (checked) {
                                        selectedFiles + file.index
                                    } else {
                                        selectedFiles - file.index
                                    }
                                }
                            )
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = file.path,
                                    style = MaterialTheme.typography.bodySmall,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                            Text(
                                text = Formatters.formatBytes(file.size),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(start = 8.dp)
                            )
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Summary bar
            if (hasMetadata && files.isNotEmpty()) {
                val summaryText = buildString {
                    append("${selectedFiles.size} files, ${Formatters.formatBytes(selectedSize)}")
                    if (freeSpace != null && freeSpace > 0) {
                        append(" / ${Formatters.formatBytes(freeSpace)} free")
                    }
                }
                Text(
                    text = summaryText,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (overCapacity) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurfaceVariant
                )

                Spacer(modifier = Modifier.height(12.dp))
            }

            HorizontalDivider()

            Spacer(modifier = Modifier.height(12.dp))

            // Action buttons
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedButton(
                    onClick = onCancel,
                    modifier = Modifier.weight(1f)
                ) {
                    Text("Cancel")
                }

                if (hasMetadata && files.isNotEmpty()) {
                    Button(
                        onClick = { onConfirm(selectedRootKey, selectedFiles) },
                        modifier = Modifier.weight(1f),
                        enabled = selectedRootKey.isNotEmpty() && selectedFiles.isNotEmpty()
                    ) {
                        Text("Download")
                    }
                }

                Button(
                    onClick = { onConfirmAll(selectedRootKey) },
                    modifier = Modifier.weight(1f),
                    enabled = selectedRootKey.isNotEmpty()
                ) {
                    Text(if (hasMetadata && files.isNotEmpty()) "All" else "Download All")
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // "Don't show again"
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onDontShowAgain() },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center
            ) {
                Text(
                    text = "Don't show again",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RootDropdown(
    roots: List<DownloadRoot>,
    rootFreeSpace: Map<String, Long>,
    selectedKey: String,
    onSelect: (String) -> Unit,
    onAddRootClick: () -> Unit
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedRoot = roots.find { it.key == selectedKey }
    val displayText = if (selectedRoot != null) {
        val free = rootFreeSpace[selectedRoot.key]
        if (free != null && free > 0) {
            "${selectedRoot.displayName} (${Formatters.formatBytes(free)} free)"
        } else {
            selectedRoot.displayName
        }
    } else if (roots.isEmpty()) {
        "No download folder configured"
    } else {
        "Select download location"
    }

    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { expanded = it }
    ) {
        OutlinedTextField(
            value = displayText,
            onValueChange = {},
            readOnly = true,
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(MenuAnchorType.PrimaryNotEditable),
            label = { Text("Download location") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            singleLine = true
        )

        ExposedDropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false }
        ) {
            roots.forEach { root ->
                val free = rootFreeSpace[root.key]
                val label = if (free != null && free > 0) {
                    "${root.displayName} (${Formatters.formatBytes(free)} free)"
                } else {
                    root.displayName
                }
                DropdownMenuItem(
                    text = { Text(label) },
                    onClick = {
                        onSelect(root.key)
                        expanded = false
                    }
                )
            }
            // "Add folder" option
            HorizontalDivider()
            DropdownMenuItem(
                text = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Default.Add,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Add folder...")
                    }
                },
                onClick = {
                    expanded = false
                    onAddRootClick()
                }
            )
        }
    }
}
