# Third-party notices

## explainer-video

Brody's explainer pipeline (`src/lib/explainer`) adapts methods from
[explainer-video](https://github.com/PaulLemaistre/explainer-video) by Paul Lemaistre, used under the MIT License:
cutting animation to measured word-level speech timings, matching beat cues in spoken order, measuring WAV durations
from the audio bytes, holding beats against Manim's real render clock with caching disabled, dimming with a scrim instead
of `set_opacity()`, outline highlights instead of `Indicate()`, building text large and scaling it down, padding scenes
to their exact length before concatenation, and seeking after `-i` when extracting frames. No code was copied verbatim;
the TTS provider contract, the Speechify speech-mark parsing and the Manim safeguards were reimplemented in TypeScript
and in Brody's scene interpreter.

```
MIT License

Copyright (c) 2026 Paul Lemaistre

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DejaVu fonts

The explainer renders text with DejaVu Sans Condensed and DejaVu Sans Mono from the `dejavu-fonts-ttf` package
(Bitstream Vera license with DejaVu changes, public domain), the same faces Brody's PDF reports use.
