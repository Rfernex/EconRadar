# Shared interaction layer

The app launcher and six apps load `motion.css?v=1` and `motion.mjs?v=1`.
The stylesheet goes at the end of the body to follow each app's existing styles.
It preserves colours, typography, text and navigation behaviour.

- Fine-pointer hover: menu nudge, button lift, icon tilt and launcher card lift.
- Touch: short press feedback, with no sticky hover treatment.
- Keyboard: visible focus ring and icon feedback.
- Navigation: a short stagger of visible top-level content surfaces, capped at six.
- Dialogs and disclosures: a brief entrance; no artificial delay before use.
- Reduced motion: no added animation or movement; preference changes cancel
  running JavaScript animations immediately.

The module observes navigation selection and direct content replacement. It does
not animate typing, timer ticks, or ordinary list updates in the same section.
It does not hide content, read saved data, change focus or handle navigation.
No framework, remote assets, or animation dependency is required.

When changing these files, bump their URL versions and all six service-worker
cache names. `build/build.py` also includes them in rebuilt shells.

Manual checks: navigate by keyboard and touch; switch sections rapidly; open a
dialog and a disclosure; check desktop and mobile navigation; check the OS Reduce
Motion setting, including changing it while an animation is running.
