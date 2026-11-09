#!/bin/bash
# Post-crash: small 3D models first (equipment), then icons, then buildings and props.
cd "$(dirname "$0")/.."
python3 tools/i2m.py src_items src_mounts src_monsters > outputs/i2m_items.log 2>&1
python3 tools/gen.py manifests/icons.json > outputs/gen_icons.log 2>&1
python3 tools/export2d.py > outputs/export2d.log 2>&1
python3 tools/i2m.py src_buildings src_props > outputs/i2m_rest.log 2>&1
echo CHAIN3 DONE
