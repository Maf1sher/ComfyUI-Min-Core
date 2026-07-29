# ComfyUI-Min-Core

Personal collection of custom ComfyUI nodes for SDXL workflows.

## Structure

```
ComfyUI-Min-Core/
├── __init__.py          # Extension entrypoint loaded by ComfyUI
├── nodes/
│   └── __init__.py      # NODE_CLASS_LIST registry
├── pyproject.toml
├── requirements.txt
└── AGENTS.md            # AI coding instructions (auto-loaded)
```

## Adding a new node

1. Create `nodes/my_node.py` with your `io.ComfyNode` subclass.
2. Import it in `nodes/__init__.py` and append the class to `NODE_CLASS_LIST`.
3. Restart ComfyUI — the node will appear under the `Min-Core` category.

## Node conventions

Nodes use the modern `comfy_api.latest` API (`io.ComfyNode`, `io.Schema`,
`io.NodeOutput`). Category for all nodes in this pack: `"Min-Core"`.
