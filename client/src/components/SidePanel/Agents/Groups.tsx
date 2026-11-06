import { useId, useState } from 'react';
import { PrincipalType } from 'librechat-data-provider';
import { ChevronDown, ChevronRight, Trash2, X } from 'lucide-react';
import { Button, Input, Label, Spinner, useToastContext } from '@librechat/client';
import type { TAdminGroup, TPrincipal } from 'librechat-data-provider';
import {
  useGetAdminGroupsQuery,
  useCreateAdminGroupMutation,
  useDeleteAdminGroupMutation,
  useGetAdminGroupMembersQuery,
  useAddAdminGroupMemberMutation,
  useRemoveAdminGroupMemberMutation,
} from '~/data-provider';
import { UnifiedPeopleSearch } from '~/components/Sharing/PeoplePicker';
import { useLocalize } from '~/hooks';

const USERS_ONLY: Array<PrincipalType.USER> = [PrincipalType.USER];

function useGroupErrorToast() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  return () => showToast({ status: 'error', message: localize('com_ui_agent_groups_error') });
}

function GroupMembers({ groupId }: { groupId: string }) {
  const localize = useLocalize();
  const showError = useGroupErrorToast();
  const { data, isLoading } = useGetAdminGroupMembersQuery(groupId);
  const addMutation = useAddAdminGroupMemberMutation({ onError: showError });
  const removeMutation = useRemoveAdminGroupMemberMutation({ onError: showError });
  const members = data?.members ?? [];

  const addPeople = (people: TPrincipal[]) => {
    people.forEach((person) => {
      if (person.id) {
        addMutation.mutate({ groupId, userId: person.id });
      }
    });
  };

  return (
    <div className="space-y-2 border-t border-border-light p-2">
      <UnifiedPeopleSearch
        onAddPeople={addPeople}
        typeFilter={USERS_ONLY}
        placeholder={localize('com_ui_agent_groups_search')}
        excludeIds={members.map((member) => member.userId)}
      />
      {isLoading && (
        <div className="flex justify-center p-2" role="status">
          <Spinner aria-label={localize('com_ui_loading')} />
        </div>
      )}
      {!isLoading && members.length === 0 && (
        <p className="p-1 text-sm text-text-secondary">
          {localize('com_ui_agent_groups_no_members')}
        </p>
      )}
      <ul className="space-y-1">
        {members.map((member) => (
          <li key={member.userId} className="flex items-center gap-2 p-1">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-text-primary">{member.name}</p>
              <p className="truncate text-xs text-text-secondary">{member.email}</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={removeMutation.isLoading}
              aria-label={localize('com_ui_agent_groups_remove_member', { 0: member.name })}
              onClick={() => removeMutation.mutate({ groupId, userId: member.userId })}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GroupRow({ group }: { group: TAdminGroup }) {
  const localize = useLocalize();
  const showError = useGroupErrorToast();
  const [isOpen, setIsOpen] = useState(false);
  const deleteMutation = useDeleteAdminGroupMutation({ onError: showError });
  const count = group.memberIds?.length ?? 0;

  return (
    <li className="rounded-xl border border-border-light bg-surface-secondary">
      <div className="flex items-center gap-1 p-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-w-0 flex-1 justify-start gap-2"
          aria-expanded={isOpen}
          aria-label={localize('com_ui_agent_groups_toggle', { 0: group.name })}
          onClick={() => setIsOpen((open) => !open)}
        >
          {isOpen ? (
            <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{group.name}</span>
          <span className="shrink-0 text-xs font-normal text-text-secondary">
            {localize(
              count === 1 ? 'com_ui_agent_groups_members_one' : 'com_ui_agent_groups_members',
              { count },
            )}
          </span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={deleteMutation.isLoading}
          aria-label={localize('com_ui_agent_groups_delete', { 0: group.name })}
          onClick={() => deleteMutation.mutate(group._id)}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      </div>
      {isOpen && <GroupMembers groupId={group._id} />}
    </li>
  );
}

/** Creates groups of people, which can then be given access to agent categories. */
export default function Groups() {
  const localize = useLocalize();
  const newNameId = useId();
  const showError = useGroupErrorToast();
  const [newName, setNewName] = useState('');
  const { data, isLoading, isError, refetch } = useGetAdminGroupsQuery();
  const createMutation = useCreateAdminGroupMutation({
    onSuccess: () => setNewName(''),
    onError: showError,
  });
  const canCreate = newName.trim().length > 0 && !createMutation.isLoading;

  const create = () => {
    if (canCreate) {
      createMutation.mutate(newName.trim());
    }
  };

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
        <p className="text-sm text-text-secondary">{localize('com_ui_agent_groups_load_error')}</p>
        <Button type="button" variant="outline" onClick={() => refetch()}>
          {localize('com_ui_retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <p className="text-sm text-text-secondary">{localize('com_ui_agent_groups_description')}</p>
      <div>
        <Label htmlFor={newNameId} className="mb-1 block text-sm font-medium text-text-primary">
          {localize('com_ui_agent_groups_new')}
        </Label>
        <div className="flex gap-2">
          <Input
            id={newNameId}
            className="min-w-0 flex-1"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                create();
              }
            }}
          />
          <Button type="button" variant="submit" disabled={!canCreate} onClick={create}>
            {localize('com_ui_agent_groups_add')}
          </Button>
        </div>
      </div>
      {data.groups.length === 0 ? (
        <p className="text-sm text-text-secondary">{localize('com_ui_agent_groups_empty')}</p>
      ) : (
        <ul className="max-h-[50vh] space-y-2 overflow-y-auto">
          {data.groups.map((group) => (
            <GroupRow key={group._id} group={group} />
          ))}
        </ul>
      )}
    </div>
  );
}
