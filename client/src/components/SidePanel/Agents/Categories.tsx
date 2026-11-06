import { useEffect, useId, useState } from 'react';
import { ArrowDown, ArrowUp, Settings2, Trash2, Users } from 'lucide-react';
import { MAX_AGENT_CATEGORY_LABEL_LENGTH, SystemRoles } from 'librechat-data-provider';
import {
  Input,
  Label,
  Radio,
  Button,
  Switch,
  Spinner,
  OGDialog,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
  OGDialogTrigger,
  useToastContext,
  OGDialogDescription,
} from '@librechat/client';
import type {
  AgentCategoryError,
  TManagedAgentCategory,
  AgentCategoryErrorCode,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import {
  useCreateAgentCategoryMutation,
  useDeleteAgentCategoryMutation,
  useUpdateAgentCategoryMutation,
  useGetManagedAgentCategoriesQuery,
  useReorderAgentCategoriesMutation,
} from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';
import CategoryAccess from './CategoryAccess';
import Groups from './Groups';

const DEFAULT_CATEGORY = 'general';
const GENERIC_ERROR: TranslationKeys = 'com_ui_agent_categories_error_generic';

const ERROR_MESSAGES: Partial<Record<AgentCategoryErrorCode, TranslationKeys>> = {
  invalid_label: 'com_ui_agent_categories_error_invalid',
  reserved_name: 'com_ui_agent_categories_error_reserved',
  category_exists: 'com_ui_agent_categories_error_exists',
  category_not_found: 'com_ui_agent_categories_error_not_found',
  category_protected: 'com_ui_agent_categories_error_protected',
  category_in_use: 'com_ui_agent_categories_error_in_use',
};

function useCategoryName() {
  const localize = useLocalize();
  return (label: string) => (label.startsWith('com_') ? localize(label as TranslationKeys) : label);
}

function AgentCount({ count }: { count: number }) {
  const localize = useLocalize();
  const key = count === 1 ? 'com_ui_agent_categories_count_one' : 'com_ui_agent_categories_count';
  return <span className="shrink-0 text-xs text-text-secondary">{localize(key, { count })}</span>;
}

interface CategoryRowProps {
  category: TManagedAgentCategory;
  isFirst: boolean;
  isLast: boolean;
  isBusy: boolean;
  onMove: (value: string, offset: number) => void;
  onRename: (value: string, label: string, onFailure: () => void) => void;
  onToggle: (value: string, isActive: boolean) => void;
  onDelete: (value: string) => void;
  onManageAccess: (value: string, name: string) => void;
}

function CategoryRow({
  category,
  isFirst,
  isLast,
  isBusy,
  onMove,
  onRename,
  onToggle,
  onDelete,
  onManageAccess,
}: CategoryRowProps) {
  const localize = useLocalize();
  const getName = useCategoryName();
  const name = getName(category.label);
  const [draft, setDraft] = useState(name);

  useEffect(() => {
    setDraft(name);
  }, [name]);

  const commitRename = () => {
    const label = draft.trim();
    if (!label || label === name) {
      setDraft(name);
      return;
    }
    onRename(category.value, label, () => setDraft(name));
  };

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-xl border border-border-light bg-surface-secondary p-2 sm:flex-nowrap">
      <div className="flex shrink-0">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={isBusy || isFirst}
          aria-label={localize('com_ui_agent_categories_move_up', { 0: name })}
          onClick={() => onMove(category.value, -1)}
        >
          <ArrowUp className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={isBusy || isLast}
          aria-label={localize('com_ui_agent_categories_move_down', { 0: name })}
          onClick={() => onMove(category.value, 1)}
        >
          <ArrowDown className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <Input
        className="min-w-0 flex-1 basis-40"
        value={draft}
        maxLength={MAX_AGENT_CATEGORY_LABEL_LENGTH}
        aria-label={localize('com_ui_agent_categories_name', { 0: name })}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitRename}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      <AgentCount count={category.count} />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 gap-1 px-1.5"
        aria-label={localize('com_ui_agent_categories_access', { 0: name })}
        title={localize('com_ui_agent_categories_access', { 0: name })}
        onClick={() => onManageAccess(category.value, name)}
      >
        <Users className="size-4" aria-hidden="true" />
        {category.accessCount > 0 && <span className="text-xs">{category.accessCount}</span>}
      </Button>
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-xs text-text-secondary" aria-hidden="true">
          {localize('com_ui_agent_categories_show')}
        </span>
        <Switch
          checked={category.isActive}
          disabled={isBusy}
          aria-label={localize('com_ui_agent_categories_show_var', { 0: name })}
          onCheckedChange={(checked) => onToggle(category.value, checked)}
        />
      </div>
      {category.builtIn ? (
        <div className="size-7 shrink-0" aria-hidden="true" />
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={isBusy}
          aria-label={localize('com_ui_agent_categories_delete', { 0: name })}
          onClick={() => onDelete(category.value)}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      )}
    </li>
  );
}

function CategoriesPanel() {
  const localize = useLocalize();
  const getName = useCategoryName();
  const newNameId = useId();
  const { showToast } = useToastContext();
  const [newName, setNewName] = useState('');
  const [accessTarget, setAccessTarget] = useState<{ value: string; name: string } | null>(null);
  const { data, isLoading, isError, refetch } = useGetManagedAgentCategoriesQuery();

  const showError = (error: AgentCategoryError) => {
    const code = error.response?.data?.code;
    const key = code ? ERROR_MESSAGES[code] : undefined;
    showToast({ status: 'error', message: localize(key ?? GENERIC_ERROR) });
  };

  const createMutation = useCreateAgentCategoryMutation({
    onSuccess: (category) => {
      setNewName('');
      showToast({
        status: 'success',
        message: localize('com_ui_agent_categories_created', { 0: category.label }),
      });
    },
    onError: showError,
  });
  const updateMutation = useUpdateAgentCategoryMutation({ onError: showError });
  const reorderMutation = useReorderAgentCategoriesMutation({ onError: showError });
  const deleteMutation = useDeleteAgentCategoryMutation({ onError: showError });
  const isBusy =
    createMutation.isLoading ||
    updateMutation.isLoading ||
    reorderMutation.isLoading ||
    deleteMutation.isLoading;

  if (accessTarget) {
    return (
      <CategoryAccess
        value={accessTarget.value}
        name={accessTarget.name}
        onBack={() => setAccessTarget(null)}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex justify-center p-8" role="status">
        <Spinner aria-label={localize('com_ui_loading')} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center gap-3 p-8" role="alert">
        <p className="text-sm text-text-secondary">
          {localize('com_ui_agent_categories_load_error')}
        </p>
        <Button type="button" variant="outline" onClick={() => refetch()}>
          {localize('com_ui_retry')}
        </Button>
      </div>
    );
  }

  const general = data.find((category) => category.value === DEFAULT_CATEGORY);
  const movable = data.filter((category) => category.value !== DEFAULT_CATEGORY);
  const canCreate = newName.trim().length > 0 && !isBusy;

  const create = () => {
    if (canCreate) {
      createMutation.mutate(newName.trim());
    }
  };

  const move = (value: string, offset: number) => {
    const values = movable.map((category) => category.value);
    const from = values.indexOf(value);
    const to = from + offset;
    [values[from], values[to]] = [values[to], values[from]];
    reorderMutation.mutate(values);
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div>
        <Label htmlFor={newNameId} className="mb-1 block text-sm font-medium text-text-primary">
          {localize('com_ui_agent_categories_new')}
        </Label>
        <div className="flex gap-2">
          <Input
            id={newNameId}
            className="min-w-0 flex-1"
            value={newName}
            maxLength={MAX_AGENT_CATEGORY_LABEL_LENGTH}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                create();
              }
            }}
          />
          <Button type="button" variant="submit" disabled={!canCreate} onClick={create}>
            {localize('com_ui_agent_categories_add')}
          </Button>
        </div>
      </div>
      <div className="max-h-[50vh] space-y-2 overflow-y-auto">
        {general && (
          <div className="flex items-center gap-2 rounded-xl border border-border-light bg-surface-secondary p-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text-primary">
                {getName(general.label)}
              </p>
              <p className="text-xs text-text-secondary">
                {localize('com_ui_agent_categories_general_hint')}
              </p>
            </div>
            <AgentCount count={general.count} />
          </div>
        )}
        <ul className="space-y-2">
          {movable.map((category, index) => (
            <CategoryRow
              key={category.value}
              category={category}
              isFirst={index === 0}
              isLast={index === movable.length - 1}
              isBusy={isBusy}
              onMove={move}
              onRename={(value, label, onFailure) =>
                updateMutation.mutate({ value, data: { label } }, { onError: onFailure })
              }
              onToggle={(value, isActive) => updateMutation.mutate({ value, data: { isActive } })}
              onDelete={(value) => deleteMutation.mutate(value)}
              onManageAccess={(value, name) => setAccessTarget({ value, name })}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Admin-only button beside the Category field that opens the category manager. */
export default function Categories() {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const [tab, setTab] = useState('categories');

  if (user?.role !== SystemRoles.ADMIN) {
    return null;
  }

  const title = localize('com_ui_agent_categories_manage');

  return (
    <OGDialog>
      <OGDialogTrigger asChild>
        <button
          type="button"
          title={title}
          aria-label={title}
          className="flex size-4 shrink-0 items-center justify-center rounded text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
        >
          <Settings2 className="size-3.5" aria-hidden="true" />
        </button>
      </OGDialogTrigger>
      <OGDialogContent className="w-11/12 max-w-2xl gap-0 overflow-hidden p-0">
        <OGDialogHeader className="px-5 pb-0 pr-14 pt-5 text-left sm:px-6">
          <OGDialogTitle className="text-xl leading-7">{title}</OGDialogTitle>
          <OGDialogDescription>
            {localize('com_ui_agent_categories_description')}
          </OGDialogDescription>
          <Radio
            options={[
              { value: 'categories', label: localize('com_ui_agent_categories_tab') },
              { value: 'groups', label: localize('com_ui_agent_groups_tab') },
            ]}
            value={tab}
            onChange={setTab}
          />
        </OGDialogHeader>
        {tab === 'categories' ? <CategoriesPanel /> : <Groups />}
      </OGDialogContent>
    </OGDialog>
  );
}
