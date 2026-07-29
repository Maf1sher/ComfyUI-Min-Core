from comfy_api.latest import ComfyExtension, io

from .nodes import NODE_CLASS_LIST


class MinCoreExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return NODE_CLASS_LIST


async def comfy_entrypoint() -> MinCoreExtension:
    return MinCoreExtension()
