// تصريحات محيطية كي يبقى `tsc --noEmit` في جذر المشروع (أندرويد) سليماً رغم وجود ملفات desktop/shims
// التي تستورد react-native-web (غير مثبّتة في جذر المشروع؛ تُثبَّت فقط داخل desktop/.stage عند بناء Windows).
declare module 'react-native-web';
declare module 'react-dom';
declare module 'react-dom/client';
