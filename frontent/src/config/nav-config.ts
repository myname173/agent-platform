import { NavGroup } from '@/types';

/**
 * Navigation configuration with RBAC support
 *
 * This configuration is used for both the sidebar navigation and Cmd+K bar.
 * Items are organized into groups, each rendered with a SidebarGroupLabel.
 *
 * RBAC Access Control:
 * Each navigation item can have an `access` property that controls visibility
 * based on permissions, plans, features, roles, and organization context.
 *
 * Examples:
 *
 * 1. Require organization:
 *    access: { requireOrg: true }
 *
 * 2. Require specific permission:
 *    access: { requireOrg: true, permission: 'org:teams:manage' }
 *
 * 3. Require specific plan:
 *    access: { plan: 'pro' }
 *
 * 4. Require specific feature:
 *    access: { feature: 'premium_access' }
 *
 * 5. Require specific role:
 *    access: { role: 'admin' }
 *
 * 6. Multiple conditions (all must be true):
 *    access: { requireOrg: true, permission: 'org:teams:manage', plan: 'pro' }
 *
 * Note: The `visible` function is deprecated but still supported for backward compatibility.
 * Use the `access` property for new items.
 */
export const navGroups: NavGroup[] = [
  {
    label: 'Platform',
    items: [
      {
        title: 'Overview',
        url: '/dashboard/overview',
        icon: 'dashboard',
        isActive: false,
        shortcut: ['o', 'o'],
        items: []
      },
      {
        title: 'Operations',
        url: '/dashboard/workflows',
        icon: 'kanban',
        isActive: false,
        shortcut: ['p', 'o'],
        items: []
      },
      {
        title: 'Keys',
        url: '/dashboard/keys',
        icon: 'lock',
        isActive: false,
        shortcut: ['k', 'k'],
        items: []
      },
      {
        title: 'Alerts',
        url: '/dashboard/alerts',
        icon: 'notification',
        isActive: false,
        shortcut: ['a', 'l'],
        items: []
      },
      {
        title: 'Knowledge',
        url: '/dashboard/knowledge',
        icon: 'fileTypeDoc',
        isActive: false,
        shortcut: ['k', 'b'],
        items: []
      },
      {
        title: 'Settings',
        url: '/dashboard/settings',
        icon: 'settings',
        isActive: false,
        shortcut: ['s', 'e'],
        items: []
      }
    ]
  },
  {
    label: 'Template Demos',
    items: [
      { title: 'Workspaces', url: '/dashboard/workspaces', icon: 'workspace', isActive: false, items: [] },
      { title: 'Product', url: '/dashboard/product', icon: 'product', isActive: false, items: [] },
      { title: 'Users', url: '/dashboard/users', icon: 'teams', isActive: false, items: [] },
      { title: 'Kanban', url: '/dashboard/kanban', icon: 'kanban', isActive: false, items: [] },
      { title: 'Chat', url: '/dashboard/chat', icon: 'chat', isActive: false, items: [] },
      { title: 'AI Chat', url: '/dashboard/ai-chat', icon: 'sparkles', isActive: false, items: [] },
      {
        title: 'Forms',
        url: '#',
        icon: 'forms',
        isActive: true,
        items: [
          { title: 'Basic Form', url: '/dashboard/forms/basic', icon: 'forms' },
          { title: 'Multi-Step Form', url: '/dashboard/forms/multi-step', icon: 'forms' },
          { title: 'Sheet & Dialog', url: '/dashboard/forms/sheet-form', icon: 'forms' },
          { title: 'Advanced Patterns', url: '/dashboard/forms/advanced', icon: 'forms' }
        ]
      },
      { title: 'React Query', url: '/dashboard/react-query', icon: 'code', isActive: false, items: [] },
      { title: 'Icons', url: '/dashboard/elements/icons', icon: 'palette', isActive: false, items: [] }
    ]
  },
  {
    label: 'Account',
    items: [
      { title: 'Exclusive', url: '/dashboard/exclusive', icon: 'exclusive', isActive: false, items: [] },
      { title: 'Profile', url: '/dashboard/profile', icon: 'profile', isActive: false, items: [] },
      { title: 'Notifications', url: '/dashboard/notifications', icon: 'notification', isActive: false, items: [] },
      {
        title: 'Billing',
        url: '/dashboard/billing',
        icon: 'billing',
        isActive: false,
        access: { requireOrg: true },
        items: []
      }
    ]
  }
];
