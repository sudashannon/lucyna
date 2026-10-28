const girl = new URL('../assets/brand/cindy-omp-girl-v1.png', import.meta.url).href;
const cat = new URL('../assets/brand/cindy-omp-cat-v1.png', import.meta.url).href;
const companions = new URL('../assets/brand/cindy-omp-companions-v1.png', import.meta.url).href;
const applicationLogo = new URL('../../assets/app-icon.png', import.meta.url).href;

export function BrandLogo({size = 32}: {size?: number}) {
  return <img className="cindy-logo" src={applicationLogo} width={size} height={size} alt="" aria-hidden="true" draggable={false} decoding="async"/>;
}

// Static, shared image URLs: streaming messages never create timers or canvases.
// Text labels and native activity indicators retain their accessible semantics.
export function BrandAvatar({kind = 'girl', size = 24}: {kind?: 'girl' | 'cat'; size?: number}) {
  return <img className={`cindy-avatar cindy-avatar-${kind}`} src={kind === 'girl' ? girl : cat} width={size} height={size} alt="" aria-hidden="true" draggable={false} decoding="async"/>;
}

export function BrandCompanions() {
  return <img className="cindy-companions" src={companions} width={144} height={144} alt="" aria-hidden="true" draggable={false} decoding="async"/>;
}
