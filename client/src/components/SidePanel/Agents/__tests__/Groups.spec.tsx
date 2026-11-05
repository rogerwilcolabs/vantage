import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import { PrincipalType } from 'librechat-data-provider';
import type { TPrincipal } from 'librechat-data-provider';
import Groups from '../Groups';

const mockShowToast = jest.fn();
const mockRefetch = jest.fn();
const mockCreate = jest.fn();
const mockDelete = jest.fn();
const mockAdd = jest.fn();
const mockRemove = jest.fn();
const mockUseGroups = jest.fn();
const mockUseMembers = jest.fn();
const mockCreateOptions: { current: { onError?: () => void } } = { current: {} };

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key} ${JSON.stringify(options)}` : key,
}));

jest.mock('~/data-provider', () => ({
  useGetAdminGroupsQuery: () => mockUseGroups(),
  useGetAdminGroupMembersQuery: (id: string) => mockUseMembers(id),
  useCreateAdminGroupMutation: (options) => {
    mockCreateOptions.current = options;
    return { mutate: mockCreate, isLoading: false };
  },
  useDeleteAdminGroupMutation: () => ({ mutate: mockDelete, isLoading: false }),
  useAddAdminGroupMemberMutation: () => ({ mutate: mockAdd, isLoading: false }),
  useRemoveAdminGroupMemberMutation: () => ({ mutate: mockRemove, isLoading: false }),
}));

const mockPerson: TPrincipal = { type: PrincipalType.USER, id: 'user-2', name: 'Lee' };

jest.mock('~/components/Sharing/PeoplePicker', () => ({
  UnifiedPeopleSearch: ({ onAddPeople }: { onAddPeople: (people: TPrincipal[]) => void }) => (
    <button type="button" aria-label="pick person" onClick={() => onAddPeople([mockPerson])} />
  ),
}));

const named = (key: string, name: string) => `${key} ${JSON.stringify({ 0: name })}`;

describe('Groups', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseGroups.mockReturnValue({
      data: {
        groups: [{ _id: 'group-1', name: 'Altitude team', memberIds: ['user-1'] }],
        total: 1,
      },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });
    mockUseMembers.mockReturnValue({
      data: { members: [{ userId: 'user-1', name: 'Sam', email: 'sam@x.co' }], total: 1 },
      isLoading: false,
    });
  });

  it('lists groups with member counts', () => {
    render(<Groups />);

    expect(screen.getByText('Altitude team')).toBeInTheDocument();
    expect(
      screen.getByText(`com_ui_agent_groups_members_one ${JSON.stringify({ count: 1 })}`),
    ).toBeInTheDocument();
  });

  it('creates a group with a trimmed name', () => {
    render(<Groups />);
    const input = screen.getByLabelText('com_ui_agent_groups_new');

    fireEvent.change(input, { target: { value: '  Echo team ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockCreate).toHaveBeenCalledWith('Echo team');
  });

  it('keeps Add off until a name is typed', () => {
    render(<Groups />);

    expect(screen.getByRole('button', { name: 'com_ui_agent_groups_add' })).toBeDisabled();
  });

  it('loads members only when a group is opened', () => {
    render(<Groups />);
    expect(mockUseMembers).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', { name: named('com_ui_agent_groups_toggle', 'Altitude team') }),
    );

    expect(mockUseMembers).toHaveBeenCalledWith('group-1');
    expect(screen.getByText('Sam')).toBeInTheDocument();
  });

  it('adds and removes members', () => {
    render(<Groups />);
    fireEvent.click(
      screen.getByRole('button', { name: named('com_ui_agent_groups_toggle', 'Altitude team') }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'pick person' }));
    expect(mockAdd).toHaveBeenCalledWith({ groupId: 'group-1', userId: 'user-2' });

    fireEvent.click(
      screen.getByRole('button', { name: named('com_ui_agent_groups_remove_member', 'Sam') }),
    );
    expect(mockRemove).toHaveBeenCalledWith({ groupId: 'group-1', userId: 'user-1' });
  });

  it('deletes a group', () => {
    render(<Groups />);

    fireEvent.click(
      screen.getByRole('button', { name: named('com_ui_agent_groups_delete', 'Altitude team') }),
    );

    expect(mockDelete).toHaveBeenCalledWith('group-1');
  });

  it('shows an error when a change fails', () => {
    render(<Groups />);

    mockCreateOptions.current.onError?.();

    expect(mockShowToast).toHaveBeenCalledWith({
      status: 'error',
      message: 'com_ui_agent_groups_error',
    });
  });

  it('shows the empty state', () => {
    mockUseGroups.mockReturnValue({
      data: { groups: [], total: 0 },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });
    render(<Groups />);

    expect(screen.getByText('com_ui_agent_groups_empty')).toBeInTheDocument();
  });

  it('offers a retry when loading fails', () => {
    mockUseGroups.mockReturnValue({ isLoading: false, isError: true, refetch: mockRefetch });
    render(<Groups />);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));

    expect(mockRefetch).toHaveBeenCalled();
  });
});
