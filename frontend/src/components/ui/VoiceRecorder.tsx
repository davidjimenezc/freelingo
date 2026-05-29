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
  const t = useTranslations('voiceRecorder')

  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef<number>(48000)
  const recordingStartedAtRef = useRef<number>(0)
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function cleanupRecorder() {
    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current)
      autoStopRef.current = null
    }
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    void audioContextRef.current?.close().catch(() => undefined)

    processorRef.current = null
    sourceRef.current = null
    streamRef.current = null
    audioContextRef.current = null
  }

  function encodeWav(samples: Float32Array[], sampleRate: number): Blob {
    const totalSamples = samples.reduce((sum, chunk) => sum + chunk.length, 0)
    const buffer = new ArrayBuffer(44 + totalSamples * 2)
    const view = new DataView(buffer)

    function writeString(offset: number, value: string) {
      for (let i = 0; i < value.length; i += 1) {
        view.setUint8(offset + i, value.charCodeAt(i))
      }
    }

    writeString(0, 'RIFF')
    view.setUint32(4, 36 + totalSamples * 2, true)
    writeString(8, 'WAVE')
    writeString(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true) // PCM
    view.setUint16(22, 1, true) // mono
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeString(36, 'data')
    view.setUint32(40, totalSamples * 2, true)

    let offset = 44
    for (const chunk of samples) {
      for (let i = 0; i < chunk.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, chunk[i]))
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
        offset += 2
      }
    }

    return new Blob([buffer], { type: 'audio/wav' })
  }

  async function stopRecording() {
    if (!audioContextRef.current) return

    const elapsedMs = Date.now() - recordingStartedAtRef.current
    const chunks = chunksRef.current.slice()
    const sampleRate = sampleRateRef.current
    cleanupRecorder()
    setState('transcribing')

    try {
      const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      if (elapsedMs < 400 || sampleCount < sampleRate * 0.25) {
        throw new Error(`Recording too short (${sampleCount} samples)`)
      }

      const blob = encodeWav(chunks, sampleRate)
      const formData = new FormData()
      formData.append('audio', blob, 'recording.wav')

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

  async function startRecording() {
    setState('recording')
    try {
      chunksRef.current = []
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const audioWindow = window as Window &
        typeof globalThis & { webkitAudioContext?: typeof AudioContext }
      const AudioContextCtor = audioWindow.AudioContext || audioWindow.webkitAudioContext
      if (!AudioContextCtor) throw new Error('AudioContext is not supported')
      const audioContext = new AudioContextCtor()
      const source = audioContext.createMediaStreamSource(stream)
      const processor = audioContext.createScriptProcessor(4096, 1, 1)

      streamRef.current = stream
      audioContextRef.current = audioContext
      sourceRef.current = source
      processorRef.current = processor
      sampleRateRef.current = audioContext.sampleRate
      recordingStartedAtRef.current = Date.now()

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0)
        chunksRef.current.push(new Float32Array(input))
        const output = event.outputBuffer.getChannelData(0)
        output.fill(0)
      }

      source.connect(processor)
      processor.connect(audioContext.destination)

      autoStopRef.current = setTimeout(() => {
        void stopRecording()
      }, maxSeconds * 1000)
    } catch {
      cleanupRecorder()
      setState('error')
      setTimeout(() => setState('idle'), 2000)
    }
  }

  async function handleClick() {
    if (disabled) return

    if (state === 'recording') {
      await stopRecording()
      return
    }

    if (state !== 'idle') return
    await startRecording()
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
