# AutoNext — Simple

A small Chrome extension with only three settings:

1. **Progress bar** — select the real course progress bar. AutoNext reads it continuously.
2. **Orange NEXT spot** — one permanent orange marker. Drag it wherever NEXT should be clicked. When progress reaches 100%, AutoNext clicks that exact spot once.
3. **Blue OK spot** — one permanent blue marker. Set it while the popup is visible. AutoNext clicks it once each time that popup appears.

The orange and blue markers stay visible on the course page and remain draggable. NEXT is only a coordinate; AutoNext does not identify or follow a NEXT element.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. After changing the extension files, click **Reload** for AutoNext and reload the course page once.

## Setup

1. Click **Set the progress bar**, hover the real bar, and click it. Use the scroll wheel if you need to cycle through nested elements.
2. Click **Set permanent NEXT spot**, then drag the orange marker onto NEXT.
3. If the course uses a popup, open it once, click **Set permanent popup OK spot**, and drag the blue marker onto OK.

That is the complete feature set. Settings are saved locally per site.
