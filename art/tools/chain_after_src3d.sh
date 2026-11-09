#!/bin/bash
# After the 3D source images: fix alpha, queue all image→3D jobs (priority order), then all 2D art.
cd "$(dirname "$0")/.."
python3 tools/fix_alpha.py outputs/src_*/*_alpha.png
python3 tools/i2m.py src_units src_items src_mounts src_monsters src_buildings src_props > outputs/i2m.log 2>&1 &
I2M=$!
sleep 20   # let i2m submit its jobs first so the GPU queue runs them first
python3 tools/gen.py manifests/textures.json > outputs/gen_textures.log 2>&1
python3 tools/gen.py manifests/ui.json > outputs/gen_ui.log 2>&1
python3 tools/gen.py manifests/portraits.json > outputs/gen_portraits.log 2>&1
python3 tools/gen.py manifests/icons.json > outputs/gen_icons.log 2>&1
python3 tools/export2d.py >> outputs/gen_icons.log 2>&1
wait $I2M
echo CHAIN DONE
