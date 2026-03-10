export const TS_QUERIES = `
  (function_declaration
    name: (identifier) @name
    parameters: (formal_parameters) @params
    body: (statement_block) @body) @function
  
  (class_declaration
    name: (type_identifier) @name
    body: (class_body) @body) @class

  (method_definition
    name: (property_identifier) @name
    parameters: (formal_parameters) @params
    body: (statement_block) @body) @method

  (import_statement source: (string) @import_source) @import
  (export_statement source: (string) @import_source) @import

  (interface_declaration) @interface
  (type_alias_declaration) @type

  (call_expression
    function: (identifier) @call_name) @call
  
  (call_expression
    function: (member_expression
        property: (property_identifier) @call_name)) @call
`;

export const PYTHON_QUERIES = `
  (function_definition
    name: (identifier) @name
    parameters: (parameters) @params
    body: (block) @body) @function

  (class_definition
    name: (identifier) @name
    body: (block) @body) @class

  (import_statement (dotted_name) @import_module) @import
  (import_from_statement module_name: (dotted_name) @import_module) @import

  (call
    function: (identifier) @call_name) @call
  
  (call
    function: (attribute
        attribute: (identifier) @call_name)) @call
`;

export const GO_QUERIES = `
  (function_declaration
    name: (identifier) @name
    parameters: (parameter_list) @params
    body: (block) @body) @function

  (method_declaration
    name: (field_identifier) @name
    parameters: (parameter_list) @params
    body: (block) @body) @method

  (type_declaration
    (type_spec
      name: (type_identifier) @name
      type: (struct_type) @body)) @class

  (type_declaration
    (type_spec
      name: (type_identifier) @name
      type: (interface_type) @body)) @interface

  (import_declaration
    (import_spec
      path: (interpreted_string_literal) @import_source)) @import

  (call_expression
    function: (identifier) @call_name) @call

  (call_expression
    function: (selector_expression
      field: (field_identifier) @call_name)) @call
`;

export const RUST_QUERIES = `
  (function_item
    name: (identifier) @name
    parameters: (parameters) @params
    body: (block) @body) @function

  (impl_item
    type: (type_identifier) @name
    body: (declaration_list) @body) @class

  (struct_item
    name: (type_identifier) @name
    body: (field_declaration_list) @body) @class

  (trait_item
    name: (type_identifier) @name
    body: (declaration_list) @body) @interface

  (enum_item
    name: (type_identifier) @name
    body: (enum_variant_list) @body) @type

  (use_declaration
    argument: (scoped_identifier) @import_source) @import

  (call_expression
    function: (identifier) @call_name) @call

  (call_expression
    function: (field_expression
      field: (field_identifier) @call_name)) @call
`;

export const JAVA_QUERIES = `
  (method_declaration
    name: (identifier) @name
    parameters: (formal_parameters) @params
    body: (block) @body) @method

  (class_declaration
    name: (identifier) @name
    body: (class_body) @body) @class

  (interface_declaration
    name: (identifier) @name
    body: (interface_body) @body) @interface

  (enum_declaration
    name: (identifier) @name
    body: (enum_body) @body) @type

  (import_declaration
    (scoped_identifier) @import_source) @import

  (method_invocation
    name: (identifier) @call_name) @call
`;

export const CSHARP_QUERIES = `
  (method_declaration
    name: (identifier) @name
    parameters: (parameter_list) @params
    body: (block) @body) @method

  (class_declaration
    name: (identifier) @name
    body: (declaration_list) @body) @class

  (interface_declaration
    name: (identifier) @name
    body: (declaration_list) @body) @interface

  (struct_declaration
    name: (identifier) @name
    body: (declaration_list) @body) @class

  (enum_declaration
    name: (identifier) @name
    body: (enum_member_declaration_list) @body) @type

  (using_directive
    (qualified_name) @import_source) @import

  (invocation_expression
    function: (identifier) @call_name) @call

  (invocation_expression
    function: (member_access_expression
      name: (identifier) @call_name)) @call
`;

export const RUBY_QUERIES = `
  (method
    name: (identifier) @name
    parameters: (method_parameters) @params
    body: (body_statement) @body) @method

  (class
    name: (constant) @name
    body: (body_statement) @body) @class

  (module
    name: (constant) @name
    body: (body_statement) @body) @class

  (call
    method: (identifier) @call_name) @call

  (call
    receiver: (constant) @import_source
    method: (identifier) @call_name) @call
`;

export const C_QUERIES = `
  (function_definition
    declarator: (function_declarator
      declarator: (identifier) @name
      parameters: (parameter_list) @params)
    body: (compound_statement) @body) @function

  (struct_specifier
    name: (type_identifier) @name
    body: (field_declaration_list) @body) @class

  (enum_specifier
    name: (type_identifier) @name
    body: (enumerator_list) @body) @type

  (preproc_include
    path: (string_literal) @import_source) @import
  (preproc_include
    path: (system_lib_string) @import_source) @import

  (call_expression
    function: (identifier) @call_name) @call
`;

export const CPP_QUERIES = `
  (function_definition
    declarator: (function_declarator
      declarator: (identifier) @name
      parameters: (parameter_list) @params)
    body: (compound_statement) @body) @function

  (class_specifier
    name: (type_identifier) @name
    body: (field_declaration_list) @body) @class

  (struct_specifier
    name: (type_identifier) @name
    body: (field_declaration_list) @body) @class

  (enum_specifier
    name: (type_identifier) @name
    body: (enumerator_list) @body) @type

  (preproc_include
    path: (string_literal) @import_source) @import
  (preproc_include
    path: (system_lib_string) @import_source) @import

  (call_expression
    function: (identifier) @call_name) @call

  (call_expression
    function: (field_expression
      field: (field_identifier) @call_name)) @call
`;

export const PHP_QUERIES = `
  (function_definition
    name: (name) @name
    parameters: (formal_parameters) @params
    body: (compound_statement) @body) @function

  (method_declaration
    name: (name) @name
    parameters: (formal_parameters) @params
    body: (compound_statement) @body) @method

  (class_declaration
    name: (name) @name
    body: (declaration_list) @body) @class

  (interface_declaration
    name: (name) @name
    body: (declaration_list) @body) @interface

  (namespace_use_declaration
    (namespace_use_clause
      (qualified_name) @import_source)) @import

  (function_call_expression
    function: (name) @call_name) @call

  (member_call_expression
    name: (name) @call_name) @call
`;

// Kotlin, Swift, Scala queries ready but require tree-sitter 0.21+
// Will be enabled when tree-sitter dependency is upgraded
