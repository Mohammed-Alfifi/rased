import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Role } from '../common/roles';

export const PUBLIC = 'rased:public';
export const SERVICE = 'rased:service';
export const MIN_ROLE = 'rased:minRole';
export const QUERY_TOKEN = 'rased:queryToken';

/** No authentication (login, health). */
export const Public = () => SetMetadata(PUBLIC, true);
/** Machine-to-machine route: the vision service, authenticated with the service key. */
export const ServiceOnly = () => SetMetadata(SERVICE, true);
/** Minimum role; roles are ordered operator < supervisor < manager < admin. */
export const MinRole = (role: Role) => SetMetadata(MIN_ROLE, role);
/** Accept the JWT as ?token= (EventSource cannot send headers). */
export const AllowQueryToken = () => SetMetadata(QUERY_TOKEN, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user);
