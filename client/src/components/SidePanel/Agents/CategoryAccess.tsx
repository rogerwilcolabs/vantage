import { useEffect, useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { Button, Spinner, useToastContext } from '@librechat/client';
import type { AgentCategoryError, TPrincipal } from 'librechat-data-provider';
import {
  useGetAgentCategoryAccessQuery,
  useSetAgentCategoryAccessMutation,
  useMakeAgentCategoryPrivateMutation,
} from '~/data-provider';
import { UnifiedPeopleSearch } from '~/components/Sharing/PeoplePicker';
import PrincipalAvatar from '~/components/Sharing/PrincipalAvatar';
import { useLocalize } from '~/hooks';

const principalKey = (principal: TPrincipal) => `${principal.type}:${principal.id}`;

interface CategoryAccessProps {
  value: string;
  name: string;
  onBack: () => void;
}

/** Chooses which people, groups and roles can see and use every agent in one category. */
export default function CategoryAccess({ value, name, onBack }: CategoryAccessProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data, isLoading, isError, refetch } = useGetAgentCategoryAccessQuery(value);
  const [principals, setPrincipals] = useState<TPrincipal[]>([]);

  const saved = data?.principals;
  useEffect(() => {
    if (saved) {
      setPrincipals(saved);
    }
  }, [saved]);

  const showError = (error: AgentCategoryError) => {
    const isGone = error.response?.data?.code === 'invalid_principal';
    showToast({
      status: 'error',
      message: localize(
        isGone
          ? 'com_ui_agent_categories_error_invalid_principal'
          : 'com_ui_agent_categories_error_generic',
      ),
    });
  };

  const saveMutation = useSetAgentCategoryAccessMutation({
    onSuccess: () => {
      showToast({ status: 'success', message: localize('com_ui_agent_categories_access_saved') });
    },
    onError: showError,
  });
  const privateMutation = useMakeAgentCategoryPrivateMutation({
    onSuccess: () => {
      showToast({ status: 'success', message: localize('com_ui_agent_categories_made_private') });
    },
    onError: showError,
  });
  const isBusy = saveMutation.isLoading || privateMutation.isLoading;

  const addPrincipals = (added: TPrincipal[]) => {
    setPrincipals((current) => {
      const existing = new Set(current.map(principalKey));
      return [...current, ...added.filter((principal) => !existing.has(principalKey(principal)))];
    });
  };

  const hasChanges =
    saved !== undefined &&
    (saved.length !== principals.length ||
      saved.some(
        (principal, index) => principalKey(principal) !== principalKey(principals[index]),
      ));

  const backButton = (
    <Button type="button" variant="ghost" size="sm" onClick={onBack}>
      <ArrowLeft className="mr-1 size-4" aria-hidden="true" />
      {localize('com_ui_back')}
    </Button>
  );

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
        <div className="flex gap-2">
          {backButton}
          <Button type="button" variant="outline" onClick={() => refetch()}>
            {localize('com_ui_retry')}
          </Button>
        </div>
      </div>
    );
  }

  const { publicAgentCount } = data;

  return (
    <div className="space-y-3 p-4 sm:p-6">
      {backButton}
      <div>
        <h3 className="text-base font-medium text-text-primary">
          {localize('com_ui_agent_categories_access_title', { 0: name })}
        </h3>
        <p className="mt-1 text-xs text-text-secondary">
          {localize('com_ui_agent_categories_access_hint')}
        </p>
      </div>
      {publicAgentCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-light bg-surface-secondary p-3">
          <p className="min-w-0 flex-1 basis-48 text-sm text-text-primary">
            {localize(
              publicAgentCount === 1
                ? 'com_ui_agent_categories_public_warning_one'
                : 'com_ui_agent_categories_public_warning',
              { count: publicAgentCount },
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isBusy}
            onClick={() => privateMutation.mutate(value)}
          >
            {localize('com_ui_agent_categories_make_private')}
          </Button>
        </div>
      )}
      <UnifiedPeopleSearch
        onAddPeople={addPrincipals}
        placeholder={localize('com_ui_agent_categories_access_search')}
        excludeIds={principals.map((principal) => principal.id)}
      />
      {principals.length === 0 ? (
        <p className="rounded-xl border border-border-light bg-surface-secondary p-3 text-sm text-text-secondary">
          {localize('com_ui_agent_categories_access_empty')}
        </p>
      ) : (
        <ul className="max-h-[35vh] space-y-2 overflow-y-auto">
          {principals.map((principal) => (
            <li
              key={principalKey(principal)}
              className="flex items-center gap-2 rounded-xl border border-border-light bg-surface-secondary p-2"
            >
              <PrincipalAvatar principal={principal} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text-primary">{principal.name}</p>
                <p className="truncate text-xs text-text-secondary">
                  {principal.email || principal.type}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={localize('com_ui_agent_categories_remove_access', {
                  0: principal.name,
                })}
                onClick={() =>
                  setPrincipals((current) =>
                    current.filter((item) => principalKey(item) !== principalKey(principal)),
                  )
                }
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="submit"
          disabled={!hasChanges || isBusy}
          onClick={() =>
            saveMutation.mutate({
              value,
              principals: principals.map(({ type, id }) => ({ type, id: id ?? '' })),
            })
          }
        >
          {localize('com_ui_save')}
        </Button>
      </div>
    </div>
  );
}
