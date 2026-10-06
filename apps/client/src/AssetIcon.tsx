/** Generated original vector icons. Text labels always remain alongside them. */
export function AssetIcon({ id, className = '' }: { id: string; className?: string }) {
  return <img className={`asset-icon ${className}`} alt="" aria-hidden="true" src={`/art/icons/${encodeURIComponent(id)}.svg`} draggable={false}/>;
}
