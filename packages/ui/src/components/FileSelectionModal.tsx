import React, { useState, useMemo } from 'react'
import { formatBytes } from '../utils/format'

export interface FileSelectionFile {
  index: number
  path: string
  filename: string
  folder: string
  length: number
}

export interface FileSelectionRoot {
  key: string
  label: string
  path: string
  /** Free disk space in bytes, or -1 if unknown */
  freeSpace?: number
}

export interface FileSelectionModalProps {
  /** Torrent name (from magnet dn= or .torrent info) */
  torrentName: string
  /** Whether metadata has been received (file list available) */
  hasMetadata: boolean
  /** Files in the torrent (empty if no metadata yet) */
  files: FileSelectionFile[]
  /** Available storage roots */
  roots: FileSelectionRoot[]
  /** Default root key (pre-selected) */
  defaultRootKey: string | null
  /** Number of torrents queued behind this one */
  queueCount: number
  /** Called when user confirms with specific files */
  onConfirm: (rootKey: string, fileIndices: number[]) => void
  /** Called when user clicks "Download All" */
  onConfirmAll: (rootKey: string) => void
  /** Called when user cancels (removes the torrent) */
  onCancel: () => void
  /** Called when user toggles "don't show again" */
  onDontShowAgain?: (value: boolean) => void
  /** Pre-selected file indices from magnet so= parameter */
  initialSelectedIndices?: number[]
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
}

const dialogStyle: React.CSSProperties = {
  background: 'var(--bg-primary, #fff)',
  borderRadius: '8px',
  boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
  padding: '20px',
  minWidth: '480px',
  maxWidth: '680px',
  maxHeight: '80vh',
  display: 'flex',
  flexDirection: 'column',
}

const titleStyle: React.CSSProperties = {
  margin: '0 0 12px 0',
  fontSize: '16px',
  fontWeight: 600,
  color: 'var(--text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const sectionLabelStyle: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-secondary, #666)',
  marginBottom: '4px',
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  borderRadius: '4px',
  border: '1px solid var(--border-primary, #ccc)',
  background: 'var(--bg-secondary, #f5f5f5)',
  color: 'var(--text-primary)',
  fontSize: '13px',
}

const fileListStyle: React.CSSProperties = {
  flex: 1,
  minHeight: '120px',
  maxHeight: '320px',
  overflow: 'auto',
  border: '1px solid var(--border-primary, #ccc)',
  borderRadius: '4px',
  marginTop: '4px',
}

const fileRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '4px 8px',
  fontSize: '13px',
  borderBottom: '1px solid var(--border-secondary, #eee)',
  gap: '8px',
}

const summaryStyle: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-secondary, #666)',
  marginTop: '8px',
}

const buttonRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '8px',
  justifyContent: 'flex-end',
  marginTop: '16px',
}

const baseButtonStyle: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: '6px',
  fontSize: '13px',
  fontWeight: 500,
  cursor: 'pointer',
  border: 'none',
}

const cancelButtonStyle: React.CSSProperties = {
  ...baseButtonStyle,
  background: 'var(--bg-secondary, #f0f0f0)',
  color: 'var(--text-primary)',
}

const primaryButtonStyle: React.CSSProperties = {
  ...baseButtonStyle,
  background: 'var(--accent-primary, #1976d2)',
  color: '#fff',
}

const disabledButtonStyle: React.CSSProperties = {
  opacity: 0.5,
  cursor: 'not-allowed',
}

const spinnerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '32px',
  color: 'var(--text-secondary, #666)',
  fontSize: '13px',
}

export function FileSelectionModal({
  torrentName,
  hasMetadata,
  files,
  roots,
  defaultRootKey,
  queueCount,
  onConfirm,
  onConfirmAll,
  onCancel,
  onDontShowAgain,
  initialSelectedIndices,
}: FileSelectionModalProps) {
  const effectiveDefaultRoot =
    defaultRootKey && roots.some((r) => r.key === defaultRootKey)
      ? defaultRootKey
      : (roots[0]?.key ?? '')
  const [selectedRootKey, setSelectedRootKey] = useState(effectiveDefaultRoot)
  // Track user deselections. If initialSelectedIndices is provided, pre-deselect files not in it.
  const allFileIndices = useMemo(() => new Set(files.map((f) => f.index)), [files])
  const hasInitialSelection =
    initialSelectedIndices !== undefined && initialSelectedIndices.length > 0
  const initialSelectedSet = useMemo(
    () => (hasInitialSelection ? new Set(initialSelectedIndices) : undefined),
    [], // Intentionally stable — only use the initial value
  )
  const [initialSelectionApplied, setInitialSelectionApplied] = useState(false)
  const [deselectedFiles, setDeselectedFiles] = useState<Set<number>>(new Set())

  // When files arrive (metadata loaded) and we have initial selection, apply it once
  if (initialSelectedSet && files.length > 0 && !initialSelectionApplied) {
    setInitialSelectionApplied(true)
    setDeselectedFiles(
      new Set(files.filter((f) => !initialSelectedSet.has(f.index)).map((f) => f.index)),
    )
  }
  const selectedFiles = useMemo(() => {
    const sel = new Set(allFileIndices)
    for (const idx of deselectedFiles) {
      if (sel.has(idx)) sel.delete(idx)
    }
    return sel
  }, [allFileIndices, deselectedFiles])
  const [dontShow, setDontShow] = useState(false)

  // No escape-to-close or click-outside-to-close — user must use Cancel/Download buttons

  const toggleFile = (index: number) => {
    setDeselectedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  const toggleAll = () => {
    if (selectedFiles.size === files.length) {
      // Deselect all
      setDeselectedFiles(new Set(files.map((f) => f.index)))
    } else {
      // Select all
      setDeselectedFiles(new Set())
    }
  }

  const selectedSize = useMemo(() => {
    return files.filter((f) => selectedFiles.has(f.index)).reduce((sum, f) => sum + f.length, 0)
  }, [files, selectedFiles])

  const totalSize = useMemo(() => {
    return files.reduce((sum, f) => sum + f.length, 0)
  }, [files])

  const hasRoot = selectedRootKey !== ''
  const selectedRoot = roots.find((r) => r.key === selectedRootKey)
  const freeSpace = selectedRoot?.freeSpace
  const hasFreeSpace = freeSpace != null && freeSpace >= 0
  const exceedsFreeSpace = hasFreeSpace && selectedSize > freeSpace

  const handleConfirm = () => {
    if (!hasRoot) return
    onConfirm(selectedRootKey, [...selectedFiles])
  }

  const handleConfirmAll = () => {
    if (!hasRoot) return
    onConfirmAll(selectedRootKey)
  }

  const handleDontShowChange = (checked: boolean) => {
    setDontShow(checked)
    onDontShowAgain?.(checked)
  }

  return (
    <div style={overlayStyle}>
      <div style={dialogStyle}>
        <h3 style={titleStyle} title={torrentName}>
          {torrentName}
        </h3>

        {/* Storage root selection */}
        {roots.length > 0 ? (
          <div style={{ marginBottom: '12px' }}>
            <div style={sectionLabelStyle}>Download location</div>
            <select
              value={selectedRootKey}
              onChange={(e) => setSelectedRootKey(e.target.value)}
              style={selectStyle}
            >
              {roots.map((root) => (
                <option key={root.key} value={root.key}>
                  {root.label} — {root.path}
                  {root.freeSpace != null && root.freeSpace >= 0
                    ? ` (${formatBytes(root.freeSpace)} free)`
                    : ''}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div
            style={{
              marginBottom: '12px',
              padding: '12px',
              background: 'var(--accent-warning-bg, #fff3cd)',
              borderRadius: '4px',
              fontSize: '13px',
              color: 'var(--text-primary)',
            }}
          >
            No download location configured. Add one in Settings before downloading.
          </div>
        )}

        {/* File list */}
        <div style={sectionLabelStyle}>Files</div>
        {!hasMetadata ? (
          <div style={{ ...fileListStyle, ...spinnerStyle }}>
            Waiting for metadata from peers...
          </div>
        ) : (
          <>
            <div style={fileListStyle}>
              {/* Select all header */}
              <div
                style={{
                  ...fileRowStyle,
                  background: 'var(--bg-secondary, #f5f5f5)',
                  fontWeight: 500,
                  position: 'sticky',
                  top: 0,
                }}
              >
                <input
                  type="checkbox"
                  checked={selectedFiles.size === files.length}
                  ref={(el) => {
                    if (el)
                      el.indeterminate = selectedFiles.size > 0 && selectedFiles.size < files.length
                  }}
                  onChange={toggleAll}
                />
                <span style={{ flex: 1 }}>
                  {selectedFiles.size === files.length
                    ? 'All files'
                    : `${selectedFiles.size} of ${files.length} files`}
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>{formatBytes(totalSize)}</span>
              </div>
              {files.map((file) => (
                <div key={file.index} style={fileRowStyle}>
                  <input
                    type="checkbox"
                    checked={selectedFiles.has(file.index)}
                    onChange={() => toggleFile(file.index)}
                  />
                  <span
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={file.path}
                  >
                    {file.folder ? `${file.folder}/` : ''}
                    {file.filename}
                  </span>
                  <span
                    style={{
                      color: 'var(--text-secondary)',
                      whiteSpace: 'nowrap',
                      fontSize: '12px',
                    }}
                  >
                    {formatBytes(file.length)}
                  </span>
                </div>
              ))}
            </div>

            {/* Summary */}
            <div
              style={{
                ...summaryStyle,
                ...(exceedsFreeSpace
                  ? { color: 'var(--accent-error, #d32f2f)', fontWeight: 500 }
                  : {}),
              }}
            >
              {selectedFiles.size} of {files.length} files selected — {formatBytes(selectedSize)}
              {hasFreeSpace ? ` / ${formatBytes(freeSpace)} free` : ''}
              {exceedsFreeSpace ? ' — not enough space' : ''}
            </div>
          </>
        )}

        {/* Bottom row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: '12px',
          }}
        >
          <label style={{ fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={dontShow}
              onChange={(e) => handleDontShowChange(e.target.checked)}
              style={{ marginRight: '4px' }}
            />
            Don&apos;t show again
          </label>

          <div style={buttonRowStyle}>
            <button style={cancelButtonStyle} onClick={onCancel}>
              Cancel
            </button>
            <button
              style={{
                ...primaryButtonStyle,
                ...(!hasRoot ? disabledButtonStyle : {}),
              }}
              onClick={handleConfirm}
              disabled={!hasRoot}
            >
              {selectedFiles.size === 0
                ? 'Add'
                : selectedFiles.size < files.length
                  ? `Download (${selectedFiles.size})`
                  : 'Download'}
            </button>
            <button
              style={{
                ...primaryButtonStyle,
                ...(!hasRoot ? disabledButtonStyle : {}),
              }}
              onClick={handleConfirmAll}
              disabled={!hasRoot}
            >
              Download All
            </button>
          </div>
        </div>

        {queueCount > 0 && (
          <div
            style={{
              fontSize: '11px',
              color: 'var(--text-secondary)',
              textAlign: 'right',
              marginTop: '4px',
            }}
          >
            {queueCount} more torrent{queueCount > 1 ? 's' : ''} waiting
          </div>
        )}
      </div>
    </div>
  )
}
