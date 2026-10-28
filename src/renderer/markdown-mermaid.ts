import {createMermaidPlugin} from '@streamdown/mermaid';

// Loaded only when a Mermaid fence is encountered. Strict rendering disables
// executable HTML and diagram click callbacks; assets stay inside this build.
const native = createMermaidPlugin({config: {
  securityLevel: 'strict', startOnLoad: false, suppressErrorRendering: true,
  htmlLabels: false, maxEdges: 1000, maxTextSize: 100000,
}});
export const mermaid: typeof native = {...native, getMermaid(config) {
  const instance = native.getMermaid(config);
  return {...instance, async render(id, source) {
    const result = await instance.render(id, source);
    // Streamdown fits the diagram itself. Mermaid's responsive width="100%"
    // otherwise causes a second shrink in the fullscreen viewer and PNG export.
    const document = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
    const svg = document.documentElement;
    const box = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (svg.localName === 'svg' && box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
      svg.setAttribute('width', String(box[2])); svg.setAttribute('height', String(box[3]));
      const style = (svg as unknown as SVGSVGElement).style;
      style.width = `${box[2]}px`; style.height = `${box[3]}px`; style.maxWidth = 'none';
      return {...result, svg: new XMLSerializer().serializeToString(svg)};
    }
    return result;
  }};
}};
