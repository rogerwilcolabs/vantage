import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import type { TManagedAgentCategory } from 'librechat-data-provider';
import Categories from '../Categories';

const mockShowToast = jest.fn();
const mockRefetch = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockReorder = jest.fn();
const mockDelete = jest.fn();
const mockUseQuery = jest.fn();
const mockUseAuthContext = jest.fn();
type MockCallback = (...args: unknown[]) => void;
const mockMutationOptions: Record<string, { onSuccess?: MockCallback; onError?: MockCallback }> =
  {};

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => mockUseAuthContext(),
  useLocalize: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key} ${JSON.stringify(options)}` : key,
}));

const mutation =
  (name: string, mutate: jest.Mock, isLoading = () => false) =>
  (options) => {
    mockMutationOptions[name] = options;
    return { mutate, isLoading: isLoading() };
  };

let mockIsCreating = false;

jest.mock('~/data-provider', () => ({
  useGetManagedAgentCategoriesQuery: () => mockUseQuery(),
  useCreateAgentCategoryMutation: (options) =>
    mutation('create', mockCreate, () => mockIsCreating)(options),
  useUpdateAgentCategoryMutation: (options) => mutation('update', mockUpdate)(options),
  useReorderAgentCategoriesMutation: (options) => mutation('reorder', mockReorder)(options),
  useDeleteAgentCategoryMutation: (options) => mutation('delete', mockDelete)(options),
}));

jest.mock('../CategoryAccess', () => ({
  __esModule: true,
  default: ({ value, name, onBack }: { value: string; name: string; onBack: () => void }) => (
    <button type="button" onClick={onBack}>{`access panel ${value} ${name}`}</button>
  ),
}));

jest.mock('../Groups', () => ({
  __esModule: true,
  default: () => <div data-testid="groups-panel" />,
}));

const category = (overrides: Partial<TManagedAgentCategory>): TManagedAgentCategory => ({
  value: 'x',
  label: 'X',
  count: 0,
  order: 1,
  isActive: true,
  builtIn: false,
  accessCount: 0,
  ...overrides,
});

const categories = [
  category({ value: 'general', label: 'com_agents_category_general', builtIn: true, count: 2 }),
  category({ value: 'hr', label: 'com_agents_category_hr', builtIn: true }),
  category({ value: 'altitude', label: 'Altitude', count: 1 }),
  category({ value: 'echo', label: 'Echo', isActive: false }),
];

const manageButton = () => screen.getByRole('button', { name: 'com_ui_agent_categories_manage' });

function openDialog() {
  render(<Categories />);
  fireEvent.click(manageButton());
  return screen.getByRole('dialog');
}

const named = (key: string, name: string) => `${key} ${JSON.stringify({ 0: name })}`;

describe('Categories', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsCreating = false;
    mockUseAuthContext.mockReturnValue({ user: { role: 'ADMIN' } });
    mockUseQuery.mockReturnValue({
      data: categories,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });
  });

  it('shows nothing to non-admins', () => {
    mockUseAuthContext.mockReturnValue({ user: { role: 'USER' } });

    const { container } = render(<Categories />);

    expect(container).toBeEmptyDOMElement();
  });

  it('does not submit the surrounding agent form when opened', () => {
    const onSubmit = jest.fn((event) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Categories />
      </form>,
    );

    fireEvent.click(manageButton());

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows a spinner while loading', () => {
    mockUseQuery.mockReturnValue({ isLoading: true, isError: false, refetch: mockRefetch });

    const dialog = openDialog();

    expect(within(dialog).getByRole('status')).toBeInTheDocument();
  });

  it('offers a retry when loading fails', () => {
    mockUseQuery.mockReturnValue({ isLoading: false, isError: true, refetch: mockRefetch });

    const dialog = openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'com_ui_retry' }));

    expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    expect(mockRefetch).toHaveBeenCalled();
  });

  describe('adding', () => {
    const input = () => screen.getByLabelText('com_ui_agent_categories_new');
    const addButton = () => screen.getByRole('button', { name: 'com_ui_agent_categories_add' });

    it('keeps Add disabled until a name is typed', () => {
      openDialog();
      expect(addButton()).toBeDisabled();

      fireEvent.change(input(), { target: { value: '   ' } });
      expect(addButton()).toBeDisabled();
    });

    it('creates from the Add button with a trimmed name', () => {
      openDialog();
      fireEvent.change(input(), { target: { value: '  Altitude Two ' } });
      fireEvent.click(addButton());

      expect(mockCreate).toHaveBeenCalledWith('Altitude Two');
    });

    it('creates on Enter', () => {
      openDialog();
      fireEvent.change(input(), { target: { value: 'Altitude Two' } });
      fireEvent.keyDown(input(), { key: 'Enter' });

      expect(mockCreate).toHaveBeenCalledWith('Altitude Two');
    });

    it('does not create twice while a create is running', () => {
      mockIsCreating = true;
      openDialog();
      fireEvent.change(input(), { target: { value: 'Altitude Two' } });
      fireEvent.keyDown(input(), { key: 'Enter' });

      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('clears the field and confirms on success', () => {
      openDialog();
      fireEvent.change(input(), { target: { value: 'Altitude Two' } });

      act(() => {
        mockMutationOptions.create.onSuccess?.(category({ label: 'Altitude Two' }));
      });

      expect(input()).toHaveValue('');
      expect(mockShowToast).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    });

    it('explains a duplicate name', () => {
      openDialog();

      mockMutationOptions.create.onError?.({ response: { data: { code: 'category_exists' } } });

      expect(mockShowToast).toHaveBeenCalledWith({
        status: 'error',
        message: 'com_ui_agent_categories_error_exists',
      });
    });

    it('falls back to a generic message for unknown failures', () => {
      openDialog();

      mockMutationOptions.create.onError?.({});

      expect(mockShowToast).toHaveBeenCalledWith({
        status: 'error',
        message: 'com_ui_agent_categories_error_generic',
      });
    });
  });

  it('shows General as locked', () => {
    const dialog = openDialog();
    const name = 'com_agents_category_general';

    expect(within(dialog).getByText('com_ui_agent_categories_general_hint')).toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText(named('com_ui_agent_categories_name', name)),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole('switch', {
        name: named('com_ui_agent_categories_show_var', name),
      }),
    ).not.toBeInTheDocument();
  });

  describe('renaming', () => {
    const nameInput = () =>
      screen.getByLabelText(named('com_ui_agent_categories_name', 'Altitude'));

    it('saves on blur', () => {
      openDialog();
      fireEvent.change(nameInput(), { target: { value: 'Altitude Clients' } });
      fireEvent.blur(nameInput());

      expect(mockUpdate).toHaveBeenCalledWith(
        { value: 'altitude', data: { label: 'Altitude Clients' } },
        expect.any(Object),
      );
    });

    it('does nothing when the name is unchanged', () => {
      openDialog();
      fireEvent.blur(nameInput());

      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('restores the name when left empty', () => {
      openDialog();
      fireEvent.change(nameInput(), { target: { value: '  ' } });
      fireEvent.blur(nameInput());

      expect(mockUpdate).not.toHaveBeenCalled();
      expect(nameInput()).toHaveValue('Altitude');
    });

    it('restores the name when saving fails', () => {
      mockUpdate.mockImplementationOnce((_variables, callbacks) => callbacks.onError());
      openDialog();
      fireEvent.change(nameInput(), { target: { value: 'Finance' } });
      fireEvent.blur(nameInput());

      expect(nameInput()).toHaveValue('Altitude');
    });
  });

  it('hides and shows a category', () => {
    openDialog();

    fireEvent.click(
      screen.getByRole('switch', { name: named('com_ui_agent_categories_show_var', 'Altitude') }),
    );
    expect(mockUpdate).toHaveBeenCalledWith({ value: 'altitude', data: { isActive: false } });

    fireEvent.click(
      screen.getByRole('switch', { name: named('com_ui_agent_categories_show_var', 'Echo') }),
    );
    expect(mockUpdate).toHaveBeenCalledWith({ value: 'echo', data: { isActive: true } });
  });

  describe('reordering', () => {
    it('sends the swapped order without General', () => {
      openDialog();

      fireEvent.click(
        screen.getByRole('button', { name: named('com_ui_agent_categories_move_up', 'Altitude') }),
      );

      expect(mockReorder).toHaveBeenCalledWith(['altitude', 'hr', 'echo']);
    });

    it('disables moving past the ends', () => {
      openDialog();

      expect(
        screen.getByRole('button', {
          name: named('com_ui_agent_categories_move_up', 'com_agents_category_hr'),
        }),
      ).toBeDisabled();
      expect(
        screen.getByRole('button', { name: named('com_ui_agent_categories_move_down', 'Echo') }),
      ).toBeDisabled();
    });
  });

  it('opens the access panel for a category and comes back', () => {
    openDialog();

    fireEvent.click(
      screen.getByRole('button', { name: named('com_ui_agent_categories_access', 'Altitude') }),
    );
    const panel = screen.getByRole('button', { name: 'access panel altitude Altitude' });
    expect(screen.queryByLabelText('com_ui_agent_categories_new')).not.toBeInTheDocument();

    fireEvent.click(panel);
    expect(screen.getByLabelText('com_ui_agent_categories_new')).toBeInTheDocument();
  });

  it('switches to the groups tab', () => {
    openDialog();

    fireEvent.click(screen.getByRole('radio', { name: 'com_ui_agent_groups_tab' }));

    expect(screen.getByTestId('groups-panel')).toBeInTheDocument();
    expect(screen.queryByLabelText('com_ui_agent_categories_new')).not.toBeInTheDocument();
  });

  describe('deleting', () => {
    it('deletes a custom category', () => {
      openDialog();

      fireEvent.click(
        screen.getByRole('button', { name: named('com_ui_agent_categories_delete', 'Echo') }),
      );

      expect(mockDelete).toHaveBeenCalledWith('echo');
    });

    it('offers no delete for built-ins', () => {
      openDialog();

      expect(
        screen.queryByRole('button', {
          name: named('com_ui_agent_categories_delete', 'com_agents_category_hr'),
        }),
      ).not.toBeInTheDocument();
    });

    it('explains why a category in use cannot be deleted', () => {
      openDialog();

      mockMutationOptions.delete.onError?.({ response: { data: { code: 'category_in_use' } } });

      expect(mockShowToast).toHaveBeenCalledWith({
        status: 'error',
        message: 'com_ui_agent_categories_error_in_use',
      });
    });
  });
});
