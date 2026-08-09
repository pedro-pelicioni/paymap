#!/bin/bash
# PAYMAP demo video — 1920x1080 H.264. Static frames with cross-fades to black.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf seg; mkdir -p seg
FPS=30
seg_build() {
  local out=$1 img=$2 dur=$3 pre=${4:-}
  local fo; fo=$(awk "BEGIN{printf \"%.2f\", $dur-0.55}")
  ffmpeg -y -loglevel error -loop 1 -t "$dur" -i "$img" \
    -vf "${pre}scale=1920:1080:flags=lanczos,setsar=1,fade=t=in:st=0:d=0.45,fade=t=out:st=${fo}:d=0.55,format=yuv420p" \
    -c:v libx264 -preset veryfast -crf 21 -r $FPS -tune stillimage "seg/$out.mp4"
}
F=frames
seg_build 01 $F/01-open.png       6.0 &
seg_build 02 $F/02-gap.png        6.5 &
seg_build 03 $F/03-evidence.png   8.5 &
seg_build 04 $F/04-chapter.png    4.5 &
seg_build 05 $F/console-live.png  7.0 &
seg_build 06 $F/console-live.png  6.0 "crop=1040:585:240:330," &
seg_build 07 $F/t1-sights.png     7.5 &
seg_build 08 $F/05-explain.png    7.0 &
seg_build 09 $F/t2-settle.png     8.5 &
seg_build 10 $F/06-loop.png       7.5 &
seg_build 11 $F/07-close.png      7.5 &
seg_build 12 $F/08-end.png        4.5 &
wait
printf "file 'seg/%02d.mp4'\n" $(seq 1 12) > concat.txt
ffmpeg -y -loglevel error -f concat -safe 0 -i concat.txt \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
  -c:v copy -c:a aac -b:a 96k -shortest -movflags +faststart demo.mp4
mkdir -p ../docs && cp demo.mp4 ../docs/demo.mp4
