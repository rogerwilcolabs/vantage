import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import { PrincipalType } from 'librechat-data-provider';
import type { TPrincipal } from 'librechat-data-provider';
import CategoryAccess from '../CategoryAccess';

const mockShowToast = jest.fn();
const mockRefetch = jest.fn();
const mockSave = jest.fn();
const mockMakePrivate = jest.fn();
const mockUseQuery = jest.fn();
const mockSaveOptions: { current: { onSuccess?: () => void; onError?: (e: unknown) => void } } = {
  current: {},
};

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key} ${JSON.stringify(options)}` : key,
}));

jest.mock('~/data-provider', () => ({
  useGetAgentCategoryAccessQuery: () => mockUseQuery(),
  useSetAgentCategoryAccessMutation: (options) => {
    mockSaveOptions.current = options;
    return { mutate: mockSave, isLoading: false };
  },
  useMakeAgentCategoryPrivateMutation: () => ({ mutate: mockMakePrivate, isLoading: false }),
}));

jest.mock('~/components/Sharing/PrincipalAvatar', () => ({
  __esModule: true,
  default: () => null,
}));

const mockNewcomer: TPrincipal = { type: PrincipalType.GROUP, id: 'group-2', name: 'New group' };

jest.mock('~/components/Sharing/PeoplePicker', () => ({
  UnifiedPeopleSearch: ({ onAddPeople }: { onAddPeople: (people: TPrincipal[]) => void }) => (
    <button type="button" aria-label="pick newcomer" onClick={() => onAddPeople([mockNewcomer])} />
  ),
}));

const saved: TPrincipal[] = [
  { type: PrincipalType.USER, id: 'user-1', name: 'Sam', email: 'sam@x.co' },
];
const loaded = (overrides = {}) => ({
  data: { principals: saved, agentCount: 3, publicAgentCount: 0, ...overrides },
  isLoading: false,
  isError: false,
  refetch: mockRefetch,
});
const onBack = jest.fn();
const renderPanel = () =>
  render(<CategoryAccess value="altitude" name="Altitude" onBack={onBack} />);
const saveButton = () => screen.getByRole('button', { name: 'com_ui_save' });

describe('CategoryAccess', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseQuery.mockReturnValue(loaded());
  });

  it('shows who has access, with Save off until something changes', () => {
    renderPanel();

    expect(screen.getByText('Sam')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('adds someone and saves the whole list', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'pick newcomer' }));
    expect(screen.getByText('New group')).toBeInTheDocument();
    fireEvent.click(saveButton());

    expect(mockSave).toHaveBeenCalledWith({
      value: 'altitude',
      principals: [
        { type: 'user', id: 'user-1' },
        { type: 'group', id: 'group-2' },
      ],
    });
  });

  it('does not add the same person twice', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'pick newcomer' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick newcomer' }));

    expect(screen.getAllByText('New group')).toHaveLength(1);
  });

  it('removes someone and saves an empty list', () => {
    renderPanel();

    fireEvent.click(
      screen.getByRole('button', {
        name: `com_ui_agent_categories_remove_access ${JSON.stringify({ 0: 'Sam' })}`,
      }),
    );
    expect(screen.getByText('com_ui_agent_categories_access_empty')).toBeInTheDocument();
    fireEvent.click(saveButton());

    expect(mockSave).toHaveBeenCalledWith({ value: 'altitude', principals: [] });
  });

  it('warns about public agents and can make them private', () => {
    mockUseQuery.mockReturnValue(loaded({ publicAgentCount: 2 }));
    renderPanel();

    expect(
      screen.getByText(`com_ui_agent_categories_public_warning ${JSON.stringify({ count: 2 })}`),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_agent_categories_make_private' }));

    expect(mockMakePrivate).toHaveBeenCalledWith('altitude');
  });

  it('says nothing about public agents when there are none', () => {
    renderPanel();

    expect(
      screen.queryByRole('button', { name: 'com_ui_agent_categories_make_private' }),
    ).not.toBeInTheDocument();
  });

  it('confirms a save and explains a failed one', () => {
    renderPanel();

    act(() => mockSaveOptions.current.onSuccess?.());
    expect(mockShowToast).toHaveBeenCalledWith({
      status: 'success',
      message: 'com_ui_agent_categories_access_saved',
    });

    act(() =>
      mockSaveOptions.current.onError?.({ response: { data: { code: 'invalid_principal' } } }),
    );
    expect(mockShowToast).toHaveBeenCalledWith({
      status: 'error',
      message: 'com_ui_agent_categories_error_invalid_principal',
    });
  });

  it('shows a spinner while loading', () => {
    mockUseQuery.mockReturnValue({ isLoading: true, isError: false, refetch: mockRefetch });
    renderPanel();

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('offers retry and back when loading fails', () => {
    mockUseQuery.mockReturnValue({ isLoading: false, isError: true, refetch: mockRefetch });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_back' }));

    expect(mockRefetch).toHaveBeenCalled();
    expect(onBack).toHaveBeenCalled();
  });
});
