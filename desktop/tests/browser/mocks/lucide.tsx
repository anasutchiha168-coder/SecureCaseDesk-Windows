import * as React from 'react';
const mk = (n: string) => (p: any) => <svg data-icon={n} width={p.size ?? 24} height={p.size ?? 24} style={{ color: p.color }} />;
export const ShieldCheck = mk('ShieldCheck'); export const Home = mk('Home'); export const FolderOpen = mk('FolderOpen');
export const Users = mk('Users'); export const FileText = mk('FileText'); export const Settings = mk('Settings'); export const UserPlus = mk('UserPlus');
export const ChevronsLeft = mk('ChevronsLeft'); export const ChevronsRight = mk('ChevronsRight');
