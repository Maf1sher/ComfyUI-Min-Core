## Project Context

ComfyUI-Min-Core is a personal custom node pack for ComfyUI targeting SDXL
workflows. Nodes live in `nodes/` and are registered in `nodes/__init__.py`.
The extension entrypoint is `__init__.py`.

## Structure

```text
ComfyUI-Min-Core/
├── __init__.py          # Extension entrypoint loaded by ComfyUI
├── doc/                 # Detailed documentation for each node
├── nodes/               # Node implementations
│   ├── __init__.py      # NODE_CLASS_LIST registry
│   └── latent_latch.py
├── web/                 # Frontend JS extensions
├── pyproject.toml
├── requirements.txt
└── AGENTS.md            # AI coding instructions (auto-loaded)
```

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
3. Create a dedicated documentation file in `doc/my_node.md`.
4. Add the node to the "Available Nodes" list in `README.md` with a link to its documentation.
5. Do not touch `__init__.py` at the package root unless the extension
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

## Documentation (doc/)

- Every node should have a dedicated documentation file in the `doc/` directory describing its functionality.
- These files must be updated whenever the node's code or behavior changes.
- AI assistants should consult these documentation files when modifying or creating new nodes to maintain consistency and understand existing patterns.

## README.md

- The `README.md` file must be strictly user-facing. It should contain a brief description stating that this is a personal custom node pack (without mentioning specific usernames), and briefly present what nodes it adds.
- Node descriptions in the `README.md` must include a reference/link to the dedicated documentation files in the `doc/` directory where more information can be found.
- Do NOT include developer instructions (like file structure or how to add a node) in the `README.md`. Keep those inside `AGENTS.md`.
