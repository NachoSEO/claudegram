#!/usr/bin/env python3
"""
Groq Whisper Transcription/Translation Script
Uses Whisper Large V3 for accurate Russian to English translation
"""

import os
import sys
import json
from groq import Groq

def transcribe_with_groq(audio_path, task="translate", language="ru"):
    """
    Transcribe or translate audio using Groq's Whisper API

    Args:
        audio_path: Path to audio file (wav, mp3, flac, etc.)
        task: "transcribe" (keep original language) or "translate" (to English)
        language: Source language code (e.g., "ru" for Russian)

    Returns:
        dict with text and segments
    """
    client = Groq()

    # Check file size (25MB limit for free tier)
    file_size = os.path.getsize(audio_path)
    file_size_mb = file_size / (1024 * 1024)
    print(f"Audio file size: {file_size_mb:.2f} MB")

    if file_size_mb > 25:
        print("Warning: File exceeds 25MB free tier limit. Consider splitting.")

    with open(audio_path, "rb") as file:
        if task == "translate":
            # Translation endpoint - translates to English
            # Note: whisper-large-v3 supports translation, turbo does not
            print(f"Translating audio from {language} to English...")
            result = client.audio.translations.create(
                file=(os.path.basename(audio_path), file.read()),
                model="whisper-large-v3",  # Use large-v3 for translation support
                response_format="verbose_json",
                temperature=0.0
            )
        else:
            # Transcription endpoint - keeps original language
            print(f"Transcribing audio in {language}...")
            result = client.audio.transcriptions.create(
                file=(os.path.basename(audio_path), file.read()),
                model="whisper-large-v3-turbo",  # Turbo is faster for transcription
                response_format="verbose_json",
                timestamp_granularities=["word", "segment"],
                language=language,
                temperature=0.0
            )

    return result


def format_timestamp_srt(seconds):
    """Convert seconds to SRT timestamp format (HH:MM:SS,mmm)"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def result_to_srt(result, min_gap=2.0, merge_threshold=0.5):
    """
    Convert Groq result to SRT format

    Args:
        result: Groq API response
        min_gap: Minimum gap (seconds) to keep between segments (removes long silences)
        merge_threshold: Merge segments closer than this (seconds)

    Returns:
        SRT formatted string
    """
    segments = result.segments if hasattr(result, 'segments') else []

    if not segments:
        # If no segments, create one from full text
        return f"1\n00:00:00,000 --> 00:00:10,000\n{result.text}\n\n"

    srt_lines = []
    index = 1

    # Process segments - compress long gaps
    adjusted_segments = []
    time_offset = 0

    for i, seg in enumerate(segments):
        start = seg.start if hasattr(seg, 'start') else seg.get('start', 0)
        end = seg.end if hasattr(seg, 'end') else seg.get('end', start + 2)
        text = seg.text if hasattr(seg, 'text') else seg.get('text', '')

        # Check gap from previous segment
        if i > 0:
            prev_end = adjusted_segments[-1]['end']
            gap = start - prev_end

            # If gap is larger than min_gap, compress it
            if gap > min_gap:
                time_offset += (gap - min_gap)

        adjusted_segments.append({
            'start': start - time_offset,
            'end': end - time_offset,
            'text': text.strip()
        })

    # Generate SRT
    for seg in adjusted_segments:
        if not seg['text']:
            continue

        start_ts = format_timestamp_srt(max(0, seg['start']))
        end_ts = format_timestamp_srt(seg['end'])

        srt_lines.append(f"{index}")
        srt_lines.append(f"{start_ts} --> {end_ts}")
        srt_lines.append(seg['text'])
        srt_lines.append("")
        index += 1

    return "\n".join(srt_lines)


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Transcribe/translate audio using Groq Whisper API")
    parser.add_argument("audio_file", help="Path to audio file")
    parser.add_argument("--task", choices=["transcribe", "translate"], default="translate",
                        help="Task: transcribe (keep language) or translate (to English)")
    parser.add_argument("--language", default="ru", help="Source language code (default: ru)")
    parser.add_argument("--output", "-o", help="Output SRT file path")
    parser.add_argument("--compress-silence", type=float, default=2.0,
                        help="Compress gaps longer than N seconds (default: 2.0)")
    parser.add_argument("--json", action="store_true", help="Output raw JSON response")

    args = parser.parse_args()

    if not os.path.exists(args.audio_file):
        print(f"Error: File not found: {args.audio_file}")
        sys.exit(1)

    # Check for API key
    if not os.environ.get("GROQ_API_KEY"):
        print("Error: GROQ_API_KEY environment variable not set")
        print("Run: export GROQ_API_KEY='your_key_here'")
        sys.exit(1)

    print(f"Processing: {args.audio_file}")
    print(f"Task: {args.task}")
    print(f"Language: {args.language}")

    # Transcribe/translate
    result = transcribe_with_groq(args.audio_file, task=args.task, language=args.language)

    if args.json:
        # Output raw JSON
        print(json.dumps(result, indent=2, default=str))
    else:
        # Convert to SRT
        srt_content = result_to_srt(result, min_gap=args.compress_silence)

        if args.output:
            with open(args.output, 'w', encoding='utf-8') as f:
                f.write(srt_content)
            print(f"\nSRT saved to: {args.output}")
        else:
            print("\n" + "="*60)
            print("SUBTITLES (SRT)")
            print("="*60)
            print(srt_content)

    print(f"\nFull text:\n{result.text}")


if __name__ == "__main__":
    main()
