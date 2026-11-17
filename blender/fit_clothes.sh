#!/bin/sh
# Refit every generated outfit to both unified bodies (after a body rebuild, or a new generation).
#   blender/fit_clothes.sh [preview-dir]
# One Blender at a time, four threads: see blender/UNIFIED_ARMOR.md, "Generated clothes".
cd "$(dirname "$0")/.." || exit 1
fit() {  # style gender source [extra options]
  style=$1; g=$2; src=$3; shift 3
  nice blender -b -t 4 --factory-startup -P blender/unified_clothes.py -- \
    --clothes "art/outputs/3d/clothes/$src.glb" --style "$style" \
    --body "game/public/assets/models/units/human_${g}_base.glb" --gender "$g" \
    --out game/public/assets/models/items ${PREVIEW:+--preview "$PREVIEW/fit-$g-$style.png"} "$@" 2>&1 |
    grep -E "Generated clothes fitted|Error|Traceback" -A6
}
PREVIEW=$1

fit commoner f commoner_f3 --collar .85   # a scooped collar: lay it on the neck
fit commoner m commoner_m1 --collar .85
for g in f m; do
  fit tunic   $g tunic_${g}1
  fit leather $g leather_${g}1 --undersuit .13,.09,.07    # padded sleeves and leggings between the plates
  fit plate   $g plate_${g}1   --undersuit .15,.15,.17    # arming doublet
  fit robe    $g robe_${g}$( [ $g = f ] && echo 2 || echo 1 )    --skirt .7 --undersuit .09,.14,.50   # the robe's own blue where a slit showed mannequin
done
