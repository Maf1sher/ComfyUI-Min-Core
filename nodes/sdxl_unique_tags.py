from comfy_api.latest import io


class MinCore_UniqueSDXLTags(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        tag_template = io.Autogrow.TemplatePrefix(
            io.String.Input("tag"),
            prefix="tag_",
            min=0,
            max=100,
        )
        return io.Schema(
            node_id="MinCore_UniqueSDXLTags",
            display_name="Unique Tags",
            category="Min-Core",
            description=(
                "Combine comma-separated prompt tags from dynamic inputs and "
                "remove duplicate tags."
            ),
            search_aliases=["unique tags", "tag deduplicator", "prompt tags"],
            inputs=[
                io.Autogrow.Input(
                    "tags",
                    template=tag_template,
                    tooltip="Dynamic text inputs containing comma-separated tags.",
                ),
                io.String.Input(
                    "separator",
                    default=",",
                    multiline=False,
                    tooltip="Separator used to split and join tags.",
                ),
            ],
            outputs=[
                io.String.Output(
                    "tags",
                    tooltip="Unique tags joined with the selected separator.",
                ),
            ],
        )

    @classmethod
    def execute(cls, tags: io.Autogrow.Type, separator: str) -> io.NodeOutput:
        if not separator:
            raise ValueError("Separator must not be empty.")

        unique_tags = []
        seen = set()
        for value in tags.values():
            for tag in value.split(separator):
                tag = tag.strip()
                if tag and tag not in seen:
                    seen.add(tag)
                    unique_tags.append(tag)

        return io.NodeOutput(separator.join(unique_tags))
