## Project Context

ComfyUI-Min-Core is a personal custom node pack for ComfyUI targeting SDXL
workflows. Nodes live in `nodes/` and are registered in `nodes/__init__.py`.
The extension entrypoint is `__init__.py`.

## Node API

All nodes use the modern `comfy_api.latest` API. The old `INPUT_TYPES` /
`RETURN_TYPES` / `FUNCTION` dict style is not used here.

Minimal node template:

```python
from comfy_api.latest import io


class MyNode(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MyNode",
            display_name="My Node",
            category="Min-Core",
            inputs=[
                io.Image.Input("image"),
            ],
            outputs=[
                io.Image.Output(),
            ],
        )

    @classmethod
    def execute(cls, image) -> io.NodeOutput:
        return io.NodeOutput(image)
```

## Adding a Node

1. Create `nodes/my_node.py` with the node class.
2. In `nodes/__init__.py`, import the class and append it to `NODE_CLASS_LIST`.
3. Do not touch `__init__.py` at the package root unless the extension
   lifecycle itself changes.

## Conventions

- Category for every node: `"Min-Core"`.
- `node_id` must be globally unique in ComfyUI — prefix with `MinCore_` when
  there is any risk of collision with another pack.
- Keep each node file focused on one node or one tightly related group.
- Do not add dependencies to `requirements.txt` unless the node cannot work
  without them. Prefer what ComfyUI already bundles (torch, PIL, numpy).
- No internet requests from node code.
- Follow the ComfyUI AGENTS.md rules in the parent directory for dtype, device,
  memory, and style guidance — they apply here too.
