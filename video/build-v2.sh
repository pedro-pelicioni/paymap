#!/bin/bash
# PAYMAP demo v2 — real motion captured from the live product over CDP screencast.
# Title cards (still) bookend; the bulk is real UI motion: landing scroll, query typed,
# Sight Board FLIP re-order, _EXPLAIN disclosure, PAY 402 -> sign -> settle -> 200.
set -euo pipefail
cd "$(dirname "$0")"
CAPS=${CAPS:?set CAPS to the screencast capture dir}
rm -rf seg2; mkdir -p seg2
FPS=30
MONO=/System/Library/Fonts/Menlo.ttc

card() { # out img dur
  local out=$1 img=$2 dur=$3
  local fo; fo=$(awk "BEGIN{printf \"%.2f\", $dur-0.50}")
  ffmpeg -y -loglevel error -loop 1 -t "$dur" -i "$img" \
    -vf "scale=1920:1080:flags=lanczos,setsar=1,fade=t=in:st=0:d=0.40,fade=t=out:st=${fo}:d=0.50,format=yuv420p" \
    -c:v libx264 -preset veryfast -crf 20 -r $FPS -tune stillimage "seg2/$out.mp4"
}

motion() { # out capdir srcfps label fadein
  local out=$1 dir=$2 sfps=$3 label=$4 fin=$5
  local esc=${label//:/\\:}
  local vf="scale=1920:1080:flags=lanczos,setsar=1"
  [ "$fin" != "0" ] && vf="$vf,fade=t=in:st=0:d=${fin}"
  vf="$vf,fps=${FPS},format=yuv420p"
  ffmpeg -y -loglevel error -framerate "$sfps" -i "$dir/f%05d.jpg" -vf "$vf" \
    -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p "seg2/$out.mp4"
}

F=frames
card 01 $F/01-open.png      5.2
card 02 $F/02-gap.png       5.4
card 03 $F/03-evidence.png  7.2
card 04 $F/04-chapter.png   2.9
motion 05 "$CAPS/s4" 53.5 "THE LANDING PAGE / localhost:5173"                     0.45
motion 06 "$CAPS/s1" 73.0 "SEARCH / the Sight Board re-orders on every keystroke"  0
motion 07 "$CAPS/s2" 72.9 "_EXPLAIN / BM25 + completeness + settlements + recency" 0
motion 08 "$CAPS/s3" 75.8 "PAY / 402 -> sign -> settle -> 200"                     0
card 09 $F/07-close.png     6.6
card 10 $F/08-end.png       4.4
printf "file 'seg2/%02d.mp4'\n" $(seq 1 10) > concat-v2.txt
ffmpeg -y -loglevel error -f concat -safe 0 -i concat-v2.txt \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
  -c:v copy -c:a aac -b:a 96k -shortest -movflags +faststart demo-v2.mp4
mkdir -p ../docs && cp demo-v2.mp4 ../docs/demo-v2.mp4
