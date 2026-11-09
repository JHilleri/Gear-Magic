#!/bin/bash
# Re-queued order: remaining units → 2D art → remaining 3D models.
cd "$(dirname "$0")/.."
python3 tools/i2m.py src_units > outputs/i2m_units.log 2>&1
python3 tools/gen.py manifests/ui.json > outputs/gen_ui.log 2>&1
python3 tools/gen.py manifests/portraits.json > outputs/gen_portraits.log 2>&1
python3 tools/gen.py manifests/icons.json > outputs/gen_icons.log 2>&1
python3 tools/export2d.py > outputs/export2d.log 2>&1
python3 tools/i2m.py src_items src_mounts src_monsters src_buildings src_props > outputs/i2m_rest.log 2>&1
echo CHAIN2 DONE
