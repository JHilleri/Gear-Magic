"""Validate shipped character geometry, animations and sockets without launching Blender.

Run: python3 blender/validate_characters.py
This checks actual GLB containers, not only the asset manifest. Browser visual QA remains separate.
"""
import json
import struct
from pathlib import Path

ASSETS = Path(__file__).resolve().parents[1] / "game" / "public" / "assets"


def read_glb(relative):
    path = ASSETS / relative
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<4sII", data)
    assert magic == b"glTF" and version == 2 and length == len(data), f"Invalid GLB: {path}"
    chunk_length, chunk_type = struct.unpack_from("<II", data, 12)
    assert chunk_type == 0x4E4F534A, f"Missing JSON chunk: {path}"
    document = json.loads(data[20:20 + chunk_length])
    assert document.get("meshes"), f"No geometry: {path}"
    return document


def main():
    manifest = json.loads((ASSETS / "manifest.json").read_text())
    count = 0
    for gender in ("m", "f"):
        for armor in ("commoner", "padded", "light", "heavy", "robe"):
            key = f"human_{gender}_{armor}"
            document = read_glb(manifest["units"][key]["file"])
            assert document.get("skins"), f"Unskinned body: {key}"
            nodes = {node.get("name") for node in document.get("nodes", [])}
            for socket in ("head", "grip.R", "grip.L", "hold.L", "chest_socket"):
                assert socket in nodes, f"Missing {socket}: {key}"
            animations = {clip.get("name") for clip in document.get("animations", [])}
            for clip in ("idle", "walk", "attack_melee", "attack_ranged", "cast", "death"):
                assert clip in animations, f"Missing {clip}: {key}"
            count += 1
        for face in (1, 2, 3):
            read_glb(manifest["heads"][f"head_{gender}{face}"]["file"])
            count += 1
    for style in ("short", "crop", "swept", "tail", "curly", "long", "braid", "bun", "bob", "ponytail", "pixie"):
        read_glb(manifest["hair"][f"hair_{style}"]["file"])
        count += 1
    for style in ("short", "full", "moustache", "goatee", "long"):
        read_glb(manifest["hair"][f"beard_{style}"]["file"])
        count += 1
    for item in ("sword", "axe", "spear", "bow", "staff", "wand", "tools", "shield_human", "pauldron_plate"):
        read_glb(manifest["items"][item]["file"])
        count += 1
    print(f"Validated {count} character GLBs: 10 fitted/rigged/animated bodies, 6 heads, 16 hair/beard pieces, 9 equipment meshes.")


if __name__ == "__main__":
    main()
