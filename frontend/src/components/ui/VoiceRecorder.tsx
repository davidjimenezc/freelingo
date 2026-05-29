'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { apiFetch } from '@/lib/api'

interface VoiceRecorderProps {
  onTranscription: (text: string) => void
  maxSeconds?: number
  disabled?: boolean
  className?: string
}

type RecorderState = 'idle' | 'recording' | 'transcribing' | 'error'

export function VoiceRecorder({
  onTranscription,
  maxSeconds = 5,
  disabled = false,
  className = '',
}: VoiceRecorderProps) {
  const [state, setState] = useState<RecorderState>('idle')
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingStartedAtRef = useRef<number>(0)
  const t = useTranslations('voiceRecorder')

  function getBestMimeType(): string | undefined {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
    ]
    return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate))
  }

  function extensionForMimeType(mimeType: string | undefined): string {
    if (!mimeType) return 'webm'
    if (mimeType.includes('ogg')) return 'ogg'
    if (mimeType.includes('mp4')) return 'm4a'
    if (mimeType.includes('wav')) return 'wav'
    return 'webm'
  }

  async function handleClick() {
    if (disabled) return

    if (state === 'recording') {
      const recorder = mediaRecorderRef.current
      if (recorder?.state === 'recording') {
        try {
          recorder.requestData()
        } catch {
          // Some browsers throw if no chunk is available yet; stop() will still
          // trigger a final dataavailable event when possible.
        }
        recorder.stop()
      }
      return
    }

    if (state !== 'idle') return

    setState('recording')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = getBestMimeType()
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      mediaRecorderRef.current = recorder
      recordingStartedAtRef.current = Date.now()
      const chunks: Blob[] = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setState('transcribing')
        try {
          const blobType = recorder.mimeType || mimeType || 'audio/webm'
          const blob = new Blob(chunks, { type: blobType })
          const elapsedMs = Date.now() - recordingStartedAtRef.current
          if (elapsedMs < 400 || blob.size < 1024) {
            throw new Error(`Recording too short or empty (${blob.size} bytes)`)
          }
          const formData = new FormData()
          formData.append('audio', blob, `recording.${extensionForMimeType(blobType)}`)

          const res = await apiFetch('/api/stt', {
            method: 'POST',
            body: formData,
          })
          if (!res.ok) throw new Error(`STT error ${res.status}`)
          const { text } = (await res.json()) as { text: string }
          onTranscription(text)
          setState('idle')
        } catch {
          setState('error')
          setTimeout(() => setState('idle'), 2000)
        }
      }

      // Request periodic chunks so short recordings still produce complete data
      // before stop(); without this, some browsers can upload an undecodable blob.
      recorder.start(250)
      // Auto-stop after maxSeconds
      setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop()
      }, maxSeconds * 1000)
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 2000)
    }
  }

  const label =
    state === 'recording'
      ? `■ ${t('stop')}`
      : state === 'transcribing'
        ? `... ${t('processing')}`
        : state === 'error'
          ? `✕ ${t('error')}`
          : `● ${t('record')}`

  const colorClass =
    state === 'recording'
      ? 'border-fl-error/60 text-fl-error-fg animate-pulse'
      : state === 'transcribing'
        ? 'border-fl-border text-fl-muted-3 animate-pulse'
        : state === 'error'
          ? 'border-fl-error/40 text-fl-error-fg'
          : disabled
            ? 'border-fl-border text-fl-muted-4 cursor-not-allowed opacity-40'
            : 'border-fl-border text-fl-muted-2 hover:border-fl-border-2 hover:text-fl-fg'

  return (
    <button
      onClick={handleClick}
      disabled={disabled && state === 'idle'}
      aria-label={state === 'recording' ? t('ariaStop') : t('ariaRecord')}
      className={`border px-3 py-2 font-mono text-xs tracking-widest uppercase transition-colors ${colorClass} ${className}`}
    >
      {label}
    </button>
  )
}
