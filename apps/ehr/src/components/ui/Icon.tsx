import React from 'react';
import {
  Home, Users, User, Clipboard, Activity, FlaskConical, Pill,
  DollarSign, BarChart3, Settings, Search, Bell, Plus, X, Check,
  ArrowLeft, ArrowRight, ChevronDown, ChevronRight, ChevronLeft,
  Edit, Trash2, Eye, Lock, LogOut, Calendar, Clock, Heart,
  AlertTriangle, Info, FileText, MapPin, Truck, Shield, Phone,
  Package, Droplet, Zap, Star, Building, Grid, List, RefreshCw,
  Download, Upload, Printer, Share2, MoreHorizontal, Layers, Stethoscope, Bed
} from 'lucide-react';

export type IconName =
  | 'home' | 'users' | 'user' | 'clipboard' | 'activity' | 'flask' | 'pill'
  | 'dollar' | 'barChart' | 'settings' | 'search' | 'bell' | 'plus' | 'x' | 'check'
  | 'arrowLeft' | 'arrowRight' | 'chevronDown' | 'chevronRight' | 'chevronLeft'
  | 'edit' | 'trash' | 'eye' | 'lock' | 'logOut' | 'calendar' | 'clock' | 'heart'
  | 'alertTriangle' | 'info' | 'fileText' | 'map' | 'truck' | 'shield' | 'phone'
  | 'package' | 'droplet' | 'zap' | 'star' | 'building' | 'grid' | 'list' | 'refresh'
  | 'download' | 'upload' | 'printer' | 'share' | 'more' | 'layers' | 'stethoscope' | 'bed';

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export const Icon: React.FC<IconProps> = ({ name, size = 16, className = '', style }) => {
  const iconMap: Record<IconName, React.ElementType> = {
    home: Home, users: Users, user: User, clipboard: Clipboard, activity: Activity,
    flask: FlaskConical, pill: Pill, dollar: DollarSign, barChart: BarChart3, settings: Settings,
    search: Search, bell: Bell, plus: Plus, x: X, check: Check, arrowLeft: ArrowLeft,
    arrowRight: ArrowRight, chevronDown: ChevronDown, chevronRight: ChevronRight,
    chevronLeft: ChevronLeft, edit: Edit, trash: Trash2, eye: Eye, lock: Lock,
    logOut: LogOut, calendar: Calendar, clock: Clock, heart: Heart, alertTriangle: AlertTriangle,
    info: Info, fileText: FileText, map: MapPin, truck: Truck, shield: Shield, phone: Phone,
    package: Package, droplet: Droplet, zap: Zap, star: Star, building: Building, grid: Grid,
    list: List, refresh: RefreshCw, download: Download, upload: Upload, printer: Printer,
    share: Share2, more: MoreHorizontal, layers: Layers, stethoscope: Stethoscope, bed: Bed
  };

  const Component = iconMap[name] || MoreHorizontal;
  return <Component size={size} className={className} style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }} />;
};
