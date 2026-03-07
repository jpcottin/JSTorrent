import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

// --- Types ---

export type ToastType = 'info' | 'success' | 'error' | 'warning'

export interface ToastOptions {
  type?: ToastType
  /** Auto-dismiss duration in ms (default 3000). 0 = no auto-dismiss. */
  duration?: number
}

interface ToastItem {
  id: number
  message: string
  type: ToastType
  duration: number
  /** Timestamp when this toast was added */
  addedAt: number
}

// --- Context ---

interface ToastContextValue {
  show: (message: string, options?: ToastOptions) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}

// --- Provider ---

const DEFAULT_DURATION = 3000
let nextId = 1

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const show = useCallback((message: string, options?: ToastOptions) => {
    const id = nextId++
    const type = options?.type ?? 'info'
    const duration = options?.duration ?? DEFAULT_DURATION
    setToasts((prev) => [...prev, { id, message, type, duration, addedAt: Date.now() }])
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

// --- Container ---

const containerStyle: React.CSSProperties = {
  position: 'fixed',
  top: 12,
  right: 12,
  zIndex: 1100,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  pointerEvents: 'none',
}

const toastKeyframes = `@keyframes toast-slide-in {
  from { opacity: 0; transform: translateX(100%); }
  to { opacity: 1; transform: translateX(0); }
}`

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[]
  onDismiss: (id: number) => void
}) {
  if (toasts.length === 0) return null
  return (
    <div style={containerStyle}>
      <style>{toastKeyframes}</style>
      {toasts.map((t) => (
        <ToastElement key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

// --- Individual Toast ---

const typeColors: Record<ToastType, string> = {
  info: 'var(--accent-primary, #1976d2)',
  success: 'var(--accent-success, #2e7d32)',
  error: 'var(--accent-error, #d32f2f)',
  warning: 'var(--accent-warning, #ed6c02)',
}

const toastStyle: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: 6,
  fontSize: 13,
  lineHeight: 1.4,
  color: '#fff',
  boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
  pointerEvents: 'auto',
  cursor: 'pointer',
  maxWidth: 360,
  wordBreak: 'break-word',
  animation: 'toast-slide-in 200ms ease-out',
}

function ToastElement({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    if (toast.duration > 0) {
      timerRef.current = setTimeout(() => onDismiss(toast.id), toast.duration)
      return () => clearTimeout(timerRef.current)
    }
  }, [toast.id, toast.duration, onDismiss])

  return (
    <div
      style={{ ...toastStyle, background: typeColors[toast.type] }}
      onClick={() => onDismiss(toast.id)}
      role="status"
    >
      {toast.message}
    </div>
  )
}
