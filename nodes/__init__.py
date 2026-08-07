# Register all node classes here.
# Import each node module and add its class to NODE_CLASS_LIST.
#
# Example:
#   from .my_node import MyNode
#   NODE_CLASS_LIST = [MyNode]

from .latent_latch import LatentLatch
from .mask_painter_latch import MaskPainterLatch
from .openpose_studio import MinCore_OpenPoseStudio, MinCore_ShowString

NODE_CLASS_LIST = [
    LatentLatch,
    MaskPainterLatch,
    MinCore_OpenPoseStudio,
    MinCore_ShowString,
]
