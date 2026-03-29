from PIL import Image

frames = [
    Image.open("green.png"),
    Image.open("green-yellow.png"),
    Image.open("off.png"),
    Image.open("red.png"),
    Image.open("red-white.png"),
    Image.open("yellow.png")
]

# main
frames[0].save( # green
    "open.webp",
    lossless=True
)

frames[0].save( # green
    "next_yellow.webp",
    save_all=True,
    append_images=[frames[1]], # green-yellow
    duration=500,
    loop=0,
    lossless=True
)

frames[5].save( # yellow
    "next_red.webp",
    lossless=True
)

frames[3].save( # red
    "train_detected.webp",
    lossless=True
)

frames[3].save( # red
    "train_crossing.webp",
    save_all=True,
    append_images=[frames[4]], # red-white
    duration=500,
    loop=0,
    lossless=True
)

# distant
frames[0].save( # green
    "main_green.webp",
    lossless=True
)

frames[5].save( # yellow
    "main_yellow.webp",
    save_all=True,
    append_images=[frames[2]], # off
    duration=500,
    loop=0,
    lossless=True
)

frames[5].save( # yellow
    "main_red.webp",
    lossless=True
)

# yard
frames[4].save( # red-white
    "yard_train_detected.webp",
    lossless=True
)

# off
frames[2].save( # off
    "off.webp",
    lossless=True
)
